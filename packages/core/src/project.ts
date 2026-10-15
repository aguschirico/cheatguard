import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import ts from "typescript";
import { readTextAt } from "./changes.js";
import { git } from "./git/exec.js";
import { isRecord } from "./util/json.js";

/** Read-only view of the project's files at the "after" state. Paths are POSIX, repo-relative. */
export interface FileSource {
  list(): readonly string[];
  read(path: string): string | null;
  exists(path: string): boolean;
}

export function memorySource(files: Record<string, string>): FileSource {
  const paths = Object.keys(files);
  return {
    list: () => paths,
    read: (p) => files[p] ?? null,
    exists: (p) => p in files,
  };
}

/** Files of a git tree (e.g. a working-tree snapshot or the index). */
export function treeSource(root: string, tree: string): FileSource {
  let listed: string[] | null = null;
  let set: Set<string> | null = null;
  const cache = new Map<string, string | null>();
  const list = (): string[] => {
    listed ??= git(root, ["ls-tree", "-r", "--name-only", "-z", tree]).split("\0").filter(Boolean);
    return listed;
  };
  return {
    list,
    read(p) {
      if (!cache.has(p)) cache.set(p, readTextAt(root, tree, p).text);
      return cache.get(p) ?? null;
    },
    exists(p) {
      set ??= new Set(list());
      return set.has(p);
    },
  };
}

/** Files on disk (fast path for hooks: no snapshot needed). Listing honors .gitignore. */
export function diskSource(root: string): FileSource {
  let listed: string[] | null = null;
  return {
    list() {
      listed ??= git(root, ["ls-files", "-co", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean);
      return listed;
    },
    read(p) {
      try {
        return readFileSync(join(root, p), "utf8");
      } catch {
        return null;
      }
    },
    exists(p) {
      try {
        return existsSync(join(root, p)) && statSync(join(root, p)).isFile();
      } catch {
        return false;
      }
    },
  };
}

export interface ProjectContext {
  root: string;
  source: FileSource;
  declaredDeps(fromFile: string): ReadonlySet<string>;
  readonly workspacePackages: ReadonlySet<string>;
  /** Repo path of the package.json that defines a workspace package name. */
  workspacePackageFile(name: string): string | undefined;
  /** True when a bare specifier is covered by tsconfig paths/baseUrl or package.json "imports". */
  isAliased(specifier: string, fromFile?: string): boolean;
  /** Resolves a relative import to an existing repo file, or null. */
  resolveRelative(fromFile: string, specifier: string): string | null;
  /** Whether a package is installed in a node_modules visible from the file (null when nothing is installed at all). */
  isInstalled(pkg: string, fromFile: string): boolean | null;
}

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));

export function isBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return BUILTINS.has(specifier) || BUILTINS.has(specifier.split("/")[0] ?? "");
}

export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0] ?? specifier;
}

interface PackageJson {
  name?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
  imports?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseJsonc(text: string): Record<string, unknown> {
  const result = ts.parseConfigFileTextToJson("config.json", text);
  return asRecord(result.config);
}

const ASSET_OR_CODE_EXTS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

export function createProjectContext(root: string, source: FileSource): ProjectContext {
  const pkgCache = new Map<string, PackageJson | null>();
  const readPkg = (dir: string): PackageJson | null => {
    if (!pkgCache.has(dir)) {
      const path = dir === "" ? "package.json" : `${dir}/package.json`;
      const text = source.read(path);
      let parsed: PackageJson | null = null;
      if (text !== null) {
        try {
          parsed = asRecord(JSON.parse(text));
        } catch {
          parsed = null;
        }
      }
      pkgCache.set(dir, parsed);
    }
    return pkgCache.get(dir) ?? null;
  };

  const depsOf = (pkg: PackageJson): string[] => {
    const names: string[] = [];
    for (const field of [
      pkg.dependencies,
      pkg.devDependencies,
      pkg.peerDependencies,
      pkg.optionalDependencies,
    ]) {
      names.push(...Object.keys(asRecord(field)));
    }
    if (typeof pkg.name === "string") names.push(pkg.name);
    return names;
  };

  let workspace: Map<string, string> | null = null;
  const workspaceFiles = (): Map<string, string> => {
    if (workspace) return workspace;
    workspace = new Map<string, string>();
    for (const file of source.list()) {
      if (!file.endsWith("package.json") || file.includes("node_modules/")) continue;
      if (file !== "package.json" && !file.endsWith("/package.json")) continue;
      const pkg = readPkg(file === "package.json" ? "" : file.slice(0, -"/package.json".length));
      if (pkg && typeof pkg.name === "string" && !workspace.has(pkg.name))
        workspace.set(pkg.name, file);
    }
    return workspace;
  };
  const ancestorDirs = (fromFile: string): string[] => {
    const dirs: string[] = [];
    let dir = posix.dirname(fromFile);
    while (true) {
      const key = dir === "." ? "" : dir;
      dirs.push(key);
      if (key === "") return dirs;
      dir = posix.dirname(dir);
    }
  };

  // tsconfig paths / baseUrl (root tsconfig.json, following relative "extends").
  const aliases: Array<{ pattern: string; targets: string[]; dir: string }> = [];
  let baseUrl: string | null = null;
  const loaded = new Set<string>();
  /** Loads paths aliases from a tsconfig (and its relative extends); returns its effective baseUrl. */
  const loadTsconfig = (path: string, depth: number, isRoot: boolean): string | null => {
    if (depth > 5 || loaded.has(path)) return null;
    loaded.add(path);
    const text = source.read(path);
    if (text === null) return null;
    const config = parseJsonc(text);
    const ext = config.extends;
    const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
    let inherited: string | null = null;
    for (const parent of Array.isArray(ext) ? ext : [ext]) {
      if (typeof parent === "string" && parent.startsWith(".")) {
        const target = posix.normalize(
          posix.join(dir, parent.endsWith(".json") ? parent : `${parent}.json`),
        );
        inherited = loadTsconfig(target, depth + 1, isRoot) ?? inherited;
      }
    }
    const options = asRecord(config.compilerOptions);
    const local =
      typeof options.baseUrl === "string"
        ? posix.normalize(posix.join(dir, options.baseUrl))
        : inherited;
    if (isRoot && local !== null) baseUrl = local;
    const targetDir = local ?? dir;
    for (const [pattern, targets] of Object.entries(asRecord(options.paths))) {
      const list = Array.isArray(targets)
        ? targets.filter((t): t is string => typeof t === "string")
        : [];
      aliases.push({ pattern, targets: list, dir: targetDir });
    }
    return local;
  };
  loadTsconfig("tsconfig.json", 0, true);
  // Monorepos and multi-target setups keep aliases in nested or sibling configs (apps/web/tsconfig.json,
  // tsconfig.web.json). They are only read when the root config does not explain a specifier.
  let allConfigsLoaded = false;
  const loadAllConfigs = (): void => {
    if (allConfigsLoaded) return;
    allConfigsLoaded = true;
    const configs = source
      .list()
      .filter((f) => /(^|\/)[tj]sconfig[\w.-]*\.json$/.test(f) && !f.includes("node_modules/"));
    for (const file of configs.slice(0, 50)) loadTsconfig(file, 0, false);
  };

  const resolveFile = (base: string): string | null => {
    const normalized = posix.normalize(base);
    if (normalized.startsWith("..") || posix.isAbsolute(normalized)) return null;
    const clean = normalized === "." ? "" : normalized.replace(/\/$/, "");
    if (clean && source.exists(clean)) return clean;
    const ext = posix.extname(clean);
    for (const replacement of JS_TO_TS[ext] ?? []) {
      const candidate = `${clean.slice(0, -ext.length)}${replacement}`;
      if (source.exists(candidate)) return candidate;
    }
    for (const e of ASSET_OR_CODE_EXTS) if (source.exists(`${clean}${e}`)) return `${clean}${e}`;
    for (const e of ASSET_OR_CODE_EXTS) {
      const candidate = clean ? `${clean}/index${e}` : `index${e}`;
      if (source.exists(candidate)) return candidate;
    }
    return null;
  };

  /** The text captured by "*" in a paths pattern, "" for exact matches, or null when it does not match. */
  const capture = (pattern: string, specifier: string): string | null => {
    const star = pattern.indexOf("*");
    if (star === -1) return pattern === specifier ? "" : null;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      !specifier.startsWith(prefix) ||
      !specifier.endsWith(suffix) ||
      specifier.length < prefix.length + suffix.length
    ) {
      return null;
    }
    return specifier.slice(prefix.length, specifier.length - suffix.length);
  };
  const matchesPattern = (pattern: string, specifier: string): boolean =>
    capture(pattern, specifier) !== null;
  /** An alias only counts when one of its targets points at a file that exists. */
  const aliasResolves = (specifier: string): boolean =>
    aliases.some(({ pattern, targets, dir }) => {
      const captured = capture(pattern, specifier);
      if (captured === null) return false;
      return targets.some((t) => resolveFile(posix.join(dir, t.replace("*", captured))) !== null);
    });

  return {
    root,
    source,
    declaredDeps(fromFile) {
      const deps = new Set<string>();
      for (const key of ancestorDirs(fromFile)) {
        const pkg = readPkg(key);
        if (pkg) for (const name of depsOf(pkg)) deps.add(name);
      }
      return deps;
    },
    get workspacePackages() {
      return new Set(workspaceFiles().keys());
    },
    workspacePackageFile(name) {
      return workspaceFiles().get(name);
    },
    isAliased(specifier, fromFile = "index.ts") {
      if (aliasResolves(specifier)) return true;
      loadAllConfigs();
      if (aliasResolves(specifier)) return true;
      if (specifier.startsWith("#")) {
        return ancestorDirs(fromFile).some((key) =>
          Object.keys(asRecord(readPkg(key)?.imports)).some((p) => matchesPattern(p, specifier)),
        );
      }
      if (baseUrl !== null && resolveFile(posix.join(baseUrl, specifier)) !== null) return true;
      return false;
    },
    isInstalled(pkg, fromFile) {
      let sawNodeModules = false;
      for (const key of ancestorDirs(fromFile)) {
        const modules = join(root, key, "node_modules");
        if (!existsSync(modules)) continue;
        sawNodeModules = true;
        if (existsSync(join(modules, pkg, "package.json"))) return true;
      }
      return sawNodeModules ? false : null;
    },
    resolveRelative(fromFile, specifier) {
      const dir = posix.dirname(fromFile);
      return resolveFile(posix.join(dir === "." ? "" : dir, specifier.split("?")[0] ?? specifier));
    },
  };
}
