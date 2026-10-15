import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { cli, createTempRepo } from "./helpers.js";

// Repros from the adversarial review: in CI, a linter that cannot run must not look like a pass.
const SRC = "export function f(a: string): number {\n  return a.length;\n}\n";
const TS_DIR = dirname(fileURLToPath(import.meta.resolve("typescript/package.json")));

function repoWith(config: unknown, installTs: boolean) {
  const repo = createTempRepo({
    "package.json": "{}",
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["src"],
    }),
    "src/a.ts": SRC,
    ".gitignore": "node_modules\n",
    "cheatguard.config.json": JSON.stringify(config),
  });
  if (installTs) {
    mkdirSync(join(repo.root, "node_modules"), { recursive: true });
    symlinkSync(TS_DIR, join(repo.root, "node_modules", "typescript"), "junction");
  }
  return repo;
}

describe("check fails closed on linters", () => {
  test("a linter listed in lint.tools that is not installed exits 3", () => {
    const repo = repoWith({ lint: { tools: ["tsc"] } }, false);
    repo.write("src/a.ts", `${SRC}export const n: number = "x";\n`);
    const r = cli(["check", "--format", "json"], { cwd: repo.root });
    expect(r.status).toBe(3);
    const out = JSON.parse(r.stdout) as { ok: boolean; toolProblems: Array<{ tool: string }> };
    expect(out.ok).toBe(false);
    expect(out.toolProblems.map((p) => p.tool)).toEqual(["tsc"]);
  });

  test("with lint.tools auto, a configured but missing linter is a warning", () => {
    const repo = repoWith({}, false);
    repo.write("src/a.ts", `${SRC}export const y = 1;\n`);
    const r = cli(["check"], { cwd: repo.root });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tsc could not run");
  });

  test("a linter that crashes exits 3 and never prints 'No issues'", () => {
    const repo = repoWith({}, false);
    // A broken install: the tsc entry script exists but crashes.
    mkdirSync(join(repo.root, "node_modules", "typescript", "bin"), { recursive: true });
    writeFileSync(
      join(repo.root, "node_modules", "typescript", "bin", "tsc"),
      'throw new Error("boom");\n',
    );
    repo.write("src/a.ts", `${SRC}export const y = 1;\n`);
    const r = cli(["check"], { cwd: repo.root });
    expect(r.status).toBe(3);
    expect(r.stdout).not.toContain("No issues");
    expect(r.stdout).toContain("could not run");
  });

  test("cheatguard lint fails closed too", () => {
    const repo = repoWith({ lint: { tools: ["tsc"] } }, false);
    repo.write("src/a.ts", `${SRC}export const y = 1;\n`);
    expect(cli(["lint"], { cwd: repo.root }).status).toBe(3);
  });
});

describe("tsc in monorepos without a root tsconfig", () => {
  function monorepo(workspaces: "pnpm" | "npm") {
    const files: Record<string, string> = {
      "package.json": JSON.stringify(workspaces === "npm" ? { workspaces: ["packages/*"] } : {}),
      "packages/a/package.json": "{}",
      "packages/a/tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, noEmit: true },
        include: ["src"],
      }),
      "packages/a/src/a.ts": SRC,
      ".gitignore": "node_modules\n",
      "cheatguard.config.json": JSON.stringify({ lint: { tools: ["tsc"] } }),
    };
    if (workspaces === "pnpm") files["pnpm-workspace.yaml"] = "packages:\n  - 'packages/*'\n";
    const repo = createTempRepo(files);
    mkdirSync(join(repo.root, "node_modules"), { recursive: true });
    symlinkSync(TS_DIR, join(repo.root, "node_modules", "typescript"), "junction");
    return repo;
  }

  test.each([["pnpm" as const], ["npm" as const]])(
    "%s workspace packages are type-checked",
    (kind) => {
      const repo = monorepo(kind);
      repo.write("packages/a/src/a.ts", `${SRC}export const n: number = "x";\n`);
      const r = cli(["check", "--format", "json"], { cwd: repo.root });
      const out = JSON.parse(r.stdout) as {
        lint?: { newDiagnostics: Array<{ file: string; code: string }> };
      };
      expect(out.lint?.newDiagnostics.map((d) => [d.file, d.code])).toEqual([
        ["packages/a/src/a.ts", "TS2322"],
      ]);
      expect(r.status).toBe(1);
    },
  );
});
