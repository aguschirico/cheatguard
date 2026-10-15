import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import picomatch from "picomatch";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import { git } from "../git/exec.js";
import { asArray, isRecord } from "../util/json.js";

function readJson(path: string): unknown {
  try {
    const parsed: unknown = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8")).config;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * The `packages:` list of a pnpm-workspace.yaml, read with a real YAML parser (the same document
 * pnpm reads). An unreadable file yields no packages, so a broken edit counts as removing them all.
 */
export function parsePnpmWorkspace(text: string): string[] {
  try {
    const doc: unknown = parseYaml(text);
    return isRecord(doc)
      ? asArray(doc.packages).filter((g): g is string => typeof g === "string")
      : [];
  } catch {
    return [];
  }
}

/** Workspace globs from pnpm-workspace.yaml (its `packages:` list) or package.json `workspaces`. */
export function workspaceGlobs(root: string): string[] {
  const pnpm = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) {
    const globs = parsePnpmWorkspace(readFileSync(pnpm, "utf8"));
    if (globs.length > 0) return globs;
  }
  const pkg = readJson(join(root, "package.json"));
  if (!isRecord(pkg)) return [];
  const workspaces = isRecord(pkg.workspaces) ? pkg.workspaces.packages : pkg.workspaces;
  return asArray(workspaces).filter((g): g is string => typeof g === "string");
}

/**
 * tsconfig projects of workspace packages (for monorepos without a root tsconfig.json): each
 * workspace package directory that has a tracked tsconfig.json.
 */
export function workspaceTsconfigs(root: string): string[] {
  const globs = workspaceGlobs(root).filter((g) => !g.startsWith("!"));
  if (globs.length === 0) return [];
  const excluded = workspaceGlobs(root)
    .filter((g) => g.startsWith("!"))
    .map((g) => g.slice(1));
  const isWorkspace = picomatch(globs.map((g) => g.replace(/\/$/, "")));
  const isExcluded = excluded.length > 0 ? picomatch(excluded) : () => false;
  return git(root, ["ls-files", "-z", "--", "*tsconfig.json"])
    .split("\0")
    .filter((path) => posix.basename(path) === "tsconfig.json")
    .filter((path) => {
      const dir = posix.dirname(path);
      return dir !== "." && isWorkspace(dir) && !isExcluded(dir);
    })
    .sort();
}
