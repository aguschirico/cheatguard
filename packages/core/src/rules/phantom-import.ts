import { isBuiltin, packageNameOf } from "../project.js";
import type { Violation } from "../types.js";
import { isRecord } from "../util/json.js";
import { newItems } from "./diffing.js";
import type { AnalyzedChange, Rule } from "./types.js";

const SCHEME_RE = /^[a-z][\w+.-]*:/i;
const REGISTRY_RE = /^(npm|jsr):/;

/** "npm:@scope/pkg@1/sub" → "@scope/pkg/sub"; plain specifiers unchanged. */
function stripRegistry(spec: string): string {
  const rest = spec.replace(REGISTRY_RE, "");
  if (rest === spec) return spec;
  const scoped = rest.startsWith("@");
  const parts = rest.split("/");
  const nameParts = scoped ? parts.slice(0, 2) : parts.slice(0, 1);
  const last = nameParts.length - 1;
  nameParts[last] = (nameParts[last] ?? "").replace(/@[^@]*$/, (m) =>
    scoped && last === 0 ? m : "",
  );
  return [...nameParts, ...parts.slice(nameParts.length)].join("/");
}

/** npm package names: lowercase, URL-safe, optional non-empty scope. "$lib", "~/x", "@/x" can only be aliases. */
const NPM_NAME_RE = /^(@[a-z0-9-][a-z0-9-._]*\/)?[a-z0-9-][a-z0-9-._]*$/;

/** Modules injected by the host at runtime (never installed from npm). */
const RUNTIME_MODULES = new Set(["vscode", "k6"]);

function typesPackage(name: string): string {
  return name.startsWith("@") ? `@types/${name.slice(1).replace("/", "__")}` : `@types/${name}`;
}

function workspacePackageIsGenuine(change: AnalyzedChange | undefined, pkg: string): boolean {
  if (!change) return true;
  if (change.status === "added") return false;
  try {
    const before: unknown = JSON.parse(change.before ?? "{}");
    return isRecord(before) && before.name === pkg;
  } catch {
    return false;
  }
}

export const phantomImport: Rule = {
  id: "phantom-import",
  scope: "file",
  defaultSeverity: "block",
  description:
    "New imports of packages that are not declared, or of relative files that do not exist.",
  check(ctx) {
    const violations: Violation[] = [];
    for (const change of ctx.changes) {
      const after = change.afterFacts;
      if (!after || change.parseError) continue;
      const added = newItems(
        change.beforeFacts?.imports ?? [],
        after.imports,
        (i) => i.specifier,
        (i) => i.specifier,
      );
      for (const imp of added) {
        const spec = stripRegistry(imp.specifier);
        if (SCHEME_RE.test(spec) && !spec.startsWith("node:")) continue;
        // Framework-generated modules (SvelteKit "./$types") exist only after codegen.
        if (spec.startsWith(".") && /(^|\/)\$types$/.test(spec)) continue;
        if (spec.startsWith(".") || spec.startsWith("/")) {
          const resolved = spec.startsWith("/")
            ? ctx.project.resolveRelative("index.ts", `.${spec}`)
            : ctx.project.resolveRelative(change.path, spec);
          if (resolved === null) {
            violations.push({
              rule: "phantom-import",
              severity: "block",
              file: change.path,
              line: imp.line,
              detail: `Import "${imp.specifier}" does not resolve to a file`,
              fix: "Import from a module that exists, or create it in this change.",
            });
          }
          continue;
        }
        if (isBuiltin(spec) || ctx.project.isAliased(spec, change.path)) continue;
        if (spec.startsWith("#")) {
          violations.push({
            rule: "phantom-import",
            severity: "block",
            file: change.path,
            line: imp.line,
            detail: `Subpath import "${spec}" is not declared in package.json "imports"`,
            fix: 'Add the mapping to package.json "imports" or import the module by its relative path.',
          });
          continue;
        }
        const pkg = packageNameOf(spec);
        if (!NPM_NAME_RE.test(pkg)) continue;
        const deps = ctx.project.declaredDeps(change.path);
        // Modules provided by the host runtime are declared only through their @types package.
        if (RUNTIME_MODULES.has(pkg) && deps.has(typesPackage(pkg))) continue;
        if (deps.has(pkg)) {
          if (
            ctx.project.isInstalled(pkg, change.path) === false &&
            !ctx.project.workspacePackageFile(pkg)
          ) {
            violations.push({
              rule: "phantom-import",
              severity: "block",
              file: change.path,
              line: imp.line,
              detail: `Package "${pkg}" is declared in package.json but not installed`,
              fix: `Install "${pkg}" (it must exist on the registry) or use a dependency that is already installed.`,
            });
          }
          continue;
        }
        // A workspace package counts only if this change did not create it or rename something into it.
        const pkgFile = ctx.project.workspacePackageFile(pkg);
        if (pkgFile && workspacePackageIsGenuine(ctx.changeFor(pkgFile), pkg)) continue;
        if (imp.typeOnly && deps.has(typesPackage(pkg))) continue;
        violations.push({
          rule: "phantom-import",
          severity: "block",
          file: change.path,
          line: imp.line,
          detail: `Package "${pkg}" is not declared in package.json`,
          fix: `Use an existing dependency, or add "${pkg}" to package.json and install it in this change.`,
        });
      }
    }
    return violations;
  },
};
