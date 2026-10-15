import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, parseConfig } from "../src/config/index.js";
import { check, checkFile, RULES, runRules } from "../src/engine.js";
import { createProjectContext, memorySource } from "../src/project.js";
import { formatHook, formatJson, formatPretty } from "../src/report/index.js";
import { createTempRepo } from "./helpers/repo.js";
import { makeChange } from "./helpers/rules.js";

const project = createProjectContext("/repo", memorySource({ "package.json": "{}" }));
const SRC = "export function f(a: string): number {\n  return a.length;\n}\n";
const WITH_ANY = SRC.replace("a: string", "a: any");
const SWALLOW = `${SRC}try { f("x"); } catch {}\n`;

describe("runRules", () => {
  test("exposes the 8 rules", () => {
    expect(RULES.map((r) => r.id)).toEqual([
      "test-weakened",
      "type-suppression",
      "config-tampering",
      "stub-left",
      "phantom-import",
      "swallowed-error",
      "duplicate-export",
      "scope-creep",
    ]);
  });

  test("sorts block before warn, then by file and line", () => {
    const result = runRules({
      changes: [
        makeChange({ path: "src/b.ts", before: SRC, after: SWALLOW }),
        makeChange({ path: "src/a.ts", before: SRC, after: WITH_ANY }),
      ],
      project,
      config: DEFAULT_CONFIG,
    });
    expect(result.violations.map((v) => [v.severity, v.file, v.rule])).toEqual([
      ["block", "src/a.ts", "type-suppression"],
      ["warn", "src/b.ts", "swallowed-error"],
    ]);
  });

  test("applies severity overrides and off", () => {
    const config = parseConfig({ rules: { "type-suppression": "warn", "swallowed-error": "off" } });
    const result = runRules({
      changes: [
        makeChange({ path: "src/a.ts", before: SRC, after: WITH_ANY }),
        makeChange({ path: "src/b.ts", before: SRC, after: SWALLOW }),
      ],
      project,
      config,
    });
    expect(result.violations.map((v) => [v.rule, v.severity])).toEqual([
      ["type-suppression", "warn"],
    ]);
  });

  test("honors ignore globs", () => {
    const config = parseConfig({ ignore: ["src/legacy/**"] });
    const result = runRules({
      changes: [makeChange({ path: "src/legacy/a.ts", before: SRC, after: WITH_ANY })],
      project,
      config,
    });
    expect(result.violations).toEqual([]);
    expect(result.filesAnalyzed).toBe(0);
  });

  test("reports parse errors as warnings and keeps going", () => {
    const result = runRules({
      changes: [
        makeChange({ path: "src/broken.ts", before: SRC, after: "const = ;\n" }),
        makeChange({ path: "src/a.ts", before: SRC, after: WITH_ANY }),
      ],
      project,
      config: DEFAULT_CONFIG,
    });
    expect(result.violations.map((v) => [v.rule, v.severity])).toEqual([
      ["type-suppression", "block"],
      ["parse-error", "warn"],
    ]);
  });

  test("records skipped files and reports oversized source files", () => {
    const big = {
      ...makeChange({ path: "big.js", before: "a", after: "b" }),
      before: null,
      after: null,
      skipReason: "too-large" as const,
    };
    const asset = {
      ...makeChange({ path: "logo.png", before: "a", after: "b" }),
      before: null,
      after: null,
      skipReason: "binary" as const,
    };
    const result = runRules({ changes: [big, asset], project, config: DEFAULT_CONFIG });
    expect(result.skipped).toEqual([
      { path: "big.js", reason: "too-large" },
      { path: "logo.png", reason: "binary" },
    ]);
    expect(result.violations.map((v) => [v.rule, v.file, v.severity])).toEqual([
      ["parse-error", "big.js", "block"],
    ]);
  });

  test("can run only file-scope rules", () => {
    const dup = `export function measureText2(a: string): number {\n  return a.length;\n}\n`;
    const original = `export function measureText(a: string): number {\n  return a.length;\n}\n`;
    const ctxProject = createProjectContext(
      "/repo",
      memorySource({ "src/a.ts": original, "src/b.ts": dup }),
    );
    const fileOnly = runRules({
      changes: [makeChange({ path: "src/b.ts", after: dup })],
      project: ctxProject,
      config: DEFAULT_CONFIG,
      scopes: ["file"],
    });
    const all = runRules({
      changes: [makeChange({ path: "src/b.ts", after: dup })],
      project: ctxProject,
      config: DEFAULT_CONFIG,
    });
    expect(fileOnly.violations).toEqual([]);
    expect(all.violations.map((v) => v.rule)).toEqual(["duplicate-export"]);
  });

  test("never throws on arbitrary file contents", () => {
    const fragment = fc.constantFrom(
      "export function f(a: any) {",
      "}",
      "try {",
      "} catch {}",
      "it('x', () => {",
      "expect(a).toBe(1);",
      "});",
      "// @ts-ignore",
      "import x from 'y';",
      "throw new Error('not implemented');",
      "return null;",
      "const a = b as unknown as C;",
      "describe.skip('s', () => {",
      "/* TODO: implement */",
      "{",
      "(",
      "`${",
      '"',
      "=>",
    );
    const source = fc.array(fragment, { maxLength: 25 }).map((parts) => parts.join("\n"));
    fc.assert(
      fc.property(
        source,
        source,
        fc.constantFrom(
          "src/a.ts",
          "src/a.test.ts",
          "tsconfig.json",
          "package.json",
          "vitest.config.ts",
        ),
        (before, after, path) => {
          runRules({
            changes: [makeChange({ path, before, after })],
            project,
            config: DEFAULT_CONFIG,
          });
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("check (git)", () => {
  test("checks the working tree against HEAD", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
    repo.write("src/a.ts", WITH_ANY);
    const result = check({
      root: repo.root,
      base: "HEAD",
      head: "worktree",
      config: DEFAULT_CONFIG,
    });
    expect(result.violations.map((v) => v.rule)).toEqual(["type-suppression"]);
  });

  test("checks only staged changes", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC, "src/b.ts": SRC });
    repo.write("src/a.ts", WITH_ANY);
    repo.write("src/b.ts", SWALLOW);
    repo.git("add", "src/b.ts");
    const result = check({ root: repo.root, base: "HEAD", head: "index", config: DEFAULT_CONFIG });
    expect(result.violations.map((v) => v.rule)).toEqual(["swallowed-error"]);
  });

  test("restricts to given paths", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC, "lib/b.ts": SRC });
    repo.write("src/a.ts", WITH_ANY);
    repo.write("lib/b.ts", WITH_ANY);
    const result = check({
      root: repo.root,
      base: "HEAD",
      head: "worktree",
      config: DEFAULT_CONFIG,
      paths: ["lib"],
    });
    expect(result.violations.map((v) => v.file)).toEqual(["lib/b.ts"]);
  });

  test("checkFile compares one file on disk against a baseline tree", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
    repo.write("src/a.ts", WITH_ANY);
    const base = repo.git("rev-parse", "HEAD^{tree}").trim();
    const result = checkFile({
      root: repo.root,
      baseTree: base,
      path: "src/a.ts",
      config: DEFAULT_CONFIG,
    });
    expect(result.violations.map((v) => v.rule)).toEqual(["type-suppression"]);
  });

  test("checkFile handles a file that does not exist in the baseline", () => {
    const repo = createTempRepo({ "package.json": "{}" });
    repo.write("src/new.ts", "export const x: any = 1;\n");
    const base = repo.git("rev-parse", "HEAD^{tree}").trim();
    expect(
      checkFile({ root: repo.root, baseTree: base, path: "src/new.ts", config: DEFAULT_CONFIG })
        .violations,
    ).toHaveLength(1);
  });

  test("checkFile ignores unsupported and ignored files", () => {
    const repo = createTempRepo({ "package.json": "{}" });
    repo.write("dist/x.ts", "export const x: any = 1;\n");
    const base = repo.git("rev-parse", "HEAD^{tree}").trim();
    expect(
      checkFile({ root: repo.root, baseTree: base, path: "dist/x.ts", config: DEFAULT_CONFIG })
        .violations,
    ).toEqual([]);
  });
});

describe("reports", () => {
  const result = runRules({
    changes: [
      makeChange({ path: "src/a.ts", before: SRC, after: WITH_ANY }),
      makeChange({ path: "src/b.ts", before: SRC, after: SWALLOW }),
    ],
    project,
    config: DEFAULT_CONFIG,
  });

  test("json is machine readable", () => {
    const parsed = JSON.parse(formatJson({ check: result })) as {
      ok: boolean;
      summary: { block: number; warn: number };
      violations: unknown[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.summary).toMatchObject({ block: 1, warn: 1 });
    expect(parsed.violations).toHaveLength(2);
  });

  test("pretty output groups by file and can be colorless", () => {
    const text = formatPretty({ check: result }, { color: false });
    expect(text).toContain("src/a.ts");
    expect(text).toContain("type-suppression");
    expect(text).toContain("1 blocking");
    expect(text).not.toContain("\u001b[");
  });

  test("hook output is compact and tells the agent what to do", () => {
    const text = formatHook({ check: result });
    expect(text).toContain("✗ [type-suppression] src/a.ts:1");
    expect(text).toContain("→ Replace `any`");
    expect(text.split("\n").length).toBeLessThan(12);
  });

  test("pretty output for a clean result says so", () => {
    expect(formatPretty({ check: { ...result, violations: [] } }, { color: false })).toContain(
      "No issues",
    );
  });
});

describe("reports with lint", () => {
  const empty = runRules({ changes: [], project, config: DEFAULT_CONFIG });
  const lint = {
    tools: [{ tool: "tsc" as const, ok: true, durationMs: 10, rawChars: 100, total: 3 }],
    newDiagnostics: Array.from({ length: 25 }, (_, i) => ({
      tool: "tsc" as const,
      file: "src/a.ts",
      line: i + 1,
      column: 1,
      code: "TS2322",
      message: `bad ${i}`,
      severity: "error" as const,
    })),
    preexisting: 4,
    outsideChange: 2,
    rawChars: 100,
    durationMs: 10,
  };

  test("caps printed diagnostics and mentions the rest", () => {
    const text = formatHook({ check: empty, lint, maxDiagnostics: 20 });
    expect(text).toContain("…and 5 more new diagnostics");
    expect(text).toContain("4 pre-existing hidden");
  });

  test("mentions diagnostics in untouched files when there is no baseline", () => {
    expect(formatPretty({ check: empty, lint }, { color: false })).toContain(
      "2 diagnostics in files you did not change",
    );
  });

  test("json keeps every diagnostic", () => {
    const parsed = JSON.parse(formatJson({ check: empty, lint, maxDiagnostics: 5 })) as {
      ok: boolean;
      lint: { newDiagnostics: unknown[] };
    };
    expect(parsed.lint.newDiagnostics).toHaveLength(25);
    expect(parsed.ok).toBe(false);
  });
});
