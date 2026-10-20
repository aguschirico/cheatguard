import { symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { computeAddedLines, type FileChange } from "../src/changes.js";
import { DEFAULT_CONFIG, parseConfig } from "../src/config/index.js";
import { fingerprintAll } from "../src/lint/fingerprint.js";
import {
  detectTools,
  planTools,
  runLint,
  selectNew,
  snapshotLintBaseline,
} from "../src/lint/index.js";
import {
  parseBiomeGithub,
  parseEslintJson,
  parseOxlintJson,
  parseTscOutput,
} from "../src/lint/parsers.js";
import type { Diagnostic } from "../src/lint/types.js";
import { createTempRepo } from "./helpers/repo.js";

const ROOT = "/repo";

describe("parsers", () => {
  test("eslint json: relative paths, severities, fatal errors, ignored-file notices skipped", () => {
    const out = JSON.stringify([
      {
        filePath: "/repo/src/a.ts",
        messages: [
          {
            ruleId: "prefer-const",
            severity: 2,
            message: "'b' is never reassigned.",
            line: 2,
            column: 5,
          },
          {
            ruleId: "no-console",
            severity: 1,
            message: "Unexpected console statement.",
            line: 4,
            column: 1,
          },
          {
            ruleId: null,
            severity: 2,
            fatal: true,
            message: "Parsing error: ';' expected.",
            line: 9,
            column: 3,
          },
        ],
      },
      {
        filePath: "/repo/dist/x.js",
        messages: [
          {
            ruleId: null,
            severity: 1,
            message: "File ignored because of a matching ignore pattern.",
          },
        ],
      },
    ]);
    expect(parseEslintJson(out, ROOT)).toEqual([
      {
        tool: "eslint",
        file: "src/a.ts",
        line: 2,
        column: 5,
        code: "prefer-const",
        message: "'b' is never reassigned.",
        severity: "error",
      },
      {
        tool: "eslint",
        file: "src/a.ts",
        line: 4,
        column: 1,
        code: "no-console",
        message: "Unexpected console statement.",
        severity: "warning",
      },
      {
        tool: "eslint",
        file: "src/a.ts",
        line: 9,
        column: 3,
        code: "parse",
        message: "Parsing error: ';' expected.",
        severity: "error",
      },
    ]);
  });

  test("eslint json: garbage output throws", () => {
    expect(() => parseEslintJson("Oops! Something went wrong!", ROOT)).toThrow();
  });

  test("biome github reporter, including escaped characters", () => {
    const out = [
      "::warning title=lint/suspicious/noExplicitAny,file=/repo/src/a.ts,line=1,endLine=1,col=17,endColumn=20::Unexpected any. Specify a different type.",
      "::error title=lint/style/useConst,file=src/b.ts,line=2,endLine=2,col=1,endColumn=4::This let declares a variable%2C only assigned once.%0Afix it",
      "Checked 2 files in 3ms.",
    ].join("\n");
    expect(parseBiomeGithub(out, ROOT)).toEqual([
      {
        tool: "biome",
        file: "src/a.ts",
        line: 1,
        column: 17,
        code: "lint/suspicious/noExplicitAny",
        message: "Unexpected any. Specify a different type.",
        severity: "warning",
      },
      {
        tool: "biome",
        file: "src/b.ts",
        line: 2,
        column: 1,
        code: "lint/style/useConst",
        message: "This let declares a variable, only assigned once. fix it",
        severity: "error",
      },
    ]);
  });

  test("oxlint json: rule codes, severities, relative and absolute paths, text before the JSON", () => {
    // Real oxlint 1.88 output; it prints a notice before the JSON when every target is ignored.
    const out = `No files found to lint. Please check your paths and ignore patterns.
{ "diagnostics": [{"message": "Variable 'unused' is declared but never used.","code": "eslint(no-unused-vars)","severity": "warning","url": "https://oxc.rs","help": "Consider removing this declaration.","filename": "src/a.ts","labels": [{"label": "'unused' is declared here","span": {"offset": 6,"length": 6,"line": 1,"column": 7}}]},
{"message": "\`debugger\` statement is not allowed","code": "eslint(no-debugger)","severity": "error","filename": "/repo/src/b.ts","labels": [{"span": {"offset": 18,"length": 9,"line": 2,"column": 1}}]},
{"message": "File could not be parsed","severity": "error","filename": "src/c.ts","labels": []}],
  "number_of_files": 3, "number_of_rules": 96, "threads_count": 8, "start_time": 0.004 }`;
    expect(parseOxlintJson(out, ROOT)).toEqual([
      {
        tool: "oxlint",
        file: "src/a.ts",
        line: 1,
        column: 7,
        code: "eslint(no-unused-vars)",
        message: "Variable 'unused' is declared but never used.",
        severity: "warning",
      },
      {
        tool: "oxlint",
        file: "src/b.ts",
        line: 2,
        column: 1,
        code: "eslint(no-debugger)",
        message: "`debugger` statement is not allowed",
        severity: "error",
      },
      {
        tool: "oxlint",
        file: "src/c.ts",
        line: 1,
        column: 1,
        code: "oxlint",
        message: "File could not be parsed",
        severity: "error",
      },
    ]);
  });

  test("oxlint json: a config error (no JSON) throws", () => {
    expect(() =>
      parseOxlintJson(
        "Failed to parse oxlint configuration file.\n  x key must be a string at line 1 column 2",
        ROOT,
      ),
    ).toThrow();
  });

  test("tsc output with continuation lines, Windows paths and CRLF", () => {
    const out = [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src\\lib\\b.ts(10,1): error TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'.",
      "  Property 'z' is missing in type 'X'.",
      "/repo/src/c.ts(1,1): warning TS6133: 'x' is declared but never read.",
      "",
    ].join("\r\n");
    expect(parseTscOutput(out, ROOT)).toEqual([
      {
        tool: "tsc",
        file: "src/a.ts",
        line: 3,
        column: 7,
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
        severity: "error",
      },
      {
        tool: "tsc",
        file: "src/lib/b.ts",
        line: 10,
        column: 1,
        code: "TS2345",
        message:
          "Argument of type 'X' is not assignable to parameter of type 'Y'. Property 'z' is missing in type 'X'.",
        severity: "error",
      },
      {
        tool: "tsc",
        file: "src/c.ts",
        line: 1,
        column: 1,
        code: "TS6133",
        message: "'x' is declared but never read.",
        severity: "warning",
      },
    ]);
  });
});

const diag = (file: string, line: number, code = "r", message = "m"): Diagnostic => ({
  tool: "eslint",
  file,
  line,
  column: 1,
  code,
  message,
  severity: "error",
});

describe("fingerprints", () => {
  test("are stable when the offending line moves", () => {
    const before = fingerprintAll([diag("a.ts", 2)], () => "let b = 2;");
    const after = fingerprintAll([diag("a.ts", 7)], () => "let b = 2;");
    expect(after).toEqual(before);
  });

  test("distinguish repeated identical diagnostics by occurrence", () => {
    const fps = fingerprintAll([diag("a.ts", 1), diag("a.ts", 5)], () => "x");
    expect(new Set(fps).size).toBe(2);
  });

  test("ignore CRLF and indentation differences in the line text", () => {
    expect(fingerprintAll([diag("a.ts", 1)], () => "  let b = 2;\r")).toEqual(
      fingerprintAll([diag("a.ts", 1)], () => "let b = 2;"),
    );
  });
});

function change(path: string, before: string | null, after: string): FileChange {
  return {
    path,
    status: before === null ? "added" : "modified",
    before,
    after,
    addedLines: computeAddedLines(before, after),
    skipReason: null,
  };
}

describe("selectNew", () => {
  const changes = [
    change("a.ts", "line1\nline2\n", "line1\nline2\nline3\n"),
    change("new.ts", null, "x\n"),
  ];
  const lines: Record<string, string[]> = {
    "a.ts": ["line1", "line2", "line3"],
    "new.ts": ["x"],
    "other.ts": ["o"],
  };
  const readLine = (file: string, line: number) => lines[file]?.[line - 1] ?? "";

  test("without a baseline, attributes by changed lines and reports untouched files separately", () => {
    const result = selectNew(
      [diag("a.ts", 1), diag("a.ts", 3), diag("new.ts", 1), diag("other.ts", 1)],
      changes,
      null,
      readLine,
    );
    expect(result.fresh.map((d) => `${d.file}:${d.line}`)).toEqual(["a.ts:3", "new.ts:1"]);
    expect(result.preexisting).toBe(1);
    expect(result.outsideChange).toBe(1);
  });

  test("with a baseline, anything not in the baseline is new, even in untouched files", () => {
    const baseline = fingerprintAll([diag("a.ts", 1)], readLine);
    const result = selectNew([diag("a.ts", 1), diag("other.ts", 1)], changes, baseline, readLine);
    expect(result.fresh.map((d) => d.file)).toEqual(["other.ts"]);
    expect(result.preexisting).toBe(1);
    expect(result.outsideChange).toBe(0);
  });
});

const WORKSPACE_NODE_MODULES = resolve(__dirname, "../../../node_modules");

function lintRepo() {
  const repo = createTempRepo({
    "package.json": JSON.stringify({ name: "fixture", type: "module" }),
    ".gitignore": "node_modules\n",
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ["src"],
    }),
    "eslint.config.mjs": `import tseslint from "typescript-eslint";\nexport default [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser }, rules: { "prefer-const": "error" } }];\n`,
    "biome.json": JSON.stringify({ linter: { rules: { recommended: true } } }),
    "src/a.ts": "let legacy = 1;\nexport const a: number = legacy;\n",
    "src/b.ts": "export const b = 2;\n",
  });
  symlinkSync(WORKSPACE_NODE_MODULES, join(repo.root, "node_modules"), "junction");
  return repo;
}

describe("detectTools", () => {
  test("finds tools that have both a config and an installed binary", () => {
    const repo = lintRepo();
    expect(detectTools(repo.root, DEFAULT_CONFIG)).toEqual(["eslint", "biome", "tsc"]);
  });

  test("honors an explicit tool list", () => {
    const repo = lintRepo();
    expect(detectTools(repo.root, parseConfig({ lint: { tools: ["tsc"] } }))).toEqual(["tsc"]);
  });

  test("finds nothing in a bare repository", () => {
    expect(detectTools(createTempRepo({ "a.ts": "" }).root, DEFAULT_CONFIG)).toEqual([]);
  });
});

describe("runLint (real tools)", () => {
  test("reports only diagnostics introduced by the change", async () => {
    const repo = lintRepo();
    const baseline = await snapshotLintBaseline(repo.root, ["eslint", "biome", "tsc"]);
    expect(baseline.errors).toEqual([]);
    repo.write("src/b.ts", "let fresh = 2;\nexport const b: string = fresh;\n");
    repo.write(
      "src/a.ts",
      "let legacy = 1;\nexport const a: number = legacy;\nexport const more = 1;\n",
    );
    const changes = [
      change(
        "src/b.ts",
        "export const b = 2;\n",
        "let fresh = 2;\nexport const b: string = fresh;\n",
      ),
      change(
        "src/a.ts",
        "let legacy = 1;\nexport const a: number = legacy;\n",
        "let legacy = 1;\nexport const a: number = legacy;\nexport const more = 1;\n",
      ),
    ];
    const result = await runLint({
      root: repo.root,
      tools: ["eslint", "biome", "tsc"],
      changes,
      baseline: baseline.fingerprints,
    });
    const found = result.newDiagnostics
      .map((d) => `${d.tool}:${d.code}:${d.file}:${d.line}`)
      .sort();
    expect(found).toEqual([
      "biome:lint/style/useConst:src/b.ts:1",
      "eslint:prefer-const:src/b.ts:1",
      "tsc:TS2322:src/b.ts:2",
    ]);
    expect(result.preexisting).toBeGreaterThanOrEqual(2);
    expect(result.tools.every((t) => t.ok)).toBe(true);
  }, 120_000);

  test("a tool that crashes is reported, not thrown", async () => {
    const repo = lintRepo();
    writeFileSync(join(repo.root, "eslint.config.mjs"), "export default [{ rules: \n");
    repo.write("src/b.ts", "export const b = 3;\n");
    const result = await runLint({
      root: repo.root,
      tools: ["eslint"],
      changes: [change("src/b.ts", "export const b = 2;\n", "export const b = 3;\n")],
      baseline: null,
    });
    expect(result.tools[0]?.ok).toBe(false);
    expect(result.tools[0]?.error).toBeTruthy();
  }, 60_000);

  test("skips per-file tools when no lintable files changed", async () => {
    const repo = lintRepo();
    const result = await runLint({
      root: repo.root,
      tools: ["eslint", "biome"],
      changes: [change("README.md", "a", "b")],
      baseline: null,
    });
    expect(result.tools).toEqual([]);
  });
});

describe("lint hardening", () => {
  test("a changed file named like a CLI option cannot inject options", async () => {
    const repo = lintRepo();
    repo.write("--config=evil.mjs", "export default [];\n");
    repo.write("src/b.ts", "let fresh = 2;\nexport const b = fresh;\n");
    const result = await runLint({
      root: repo.root,
      tools: ["eslint"],
      changes: [
        change("--config=evil.mjs", null, "export default [];\n"),
        change("src/b.ts", "export const b = 2;\n", "let fresh = 2;\nexport const b = fresh;\n"),
      ],
      baseline: null,
    });
    expect(result.newDiagnostics.map((d) => `${d.code}:${d.file}`)).toContain(
      "prefer-const:src/b.ts",
    );
  }, 60_000);
});

function oxlintRepo(config: string | null, scripts: Record<string, string> = {}) {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fixture", type: "module", scripts }),
    ".gitignore": "node_modules\n",
    "src/a.ts": "debugger;\nexport const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
  };
  if (config !== null) files[".oxlintrc.json"] = config;
  const repo = createTempRepo(files);
  symlinkSync(WORKSPACE_NODE_MODULES, join(repo.root, "node_modules"), "junction");
  return repo;
}

describe("oxlint", () => {
  test("is detected by its config file, or by a package script that runs it", () => {
    expect(detectTools(oxlintRepo("{}").root, DEFAULT_CONFIG)).toEqual(["oxlint"]);
    expect(detectTools(oxlintRepo(null, { lint: "oxlint src" }).root, DEFAULT_CONFIG)).toEqual([
      "oxlint",
    ]);
    expect(detectTools(oxlintRepo(null, { lint: "eslint ." }).root, DEFAULT_CONFIG)).toEqual([]);
  });

  test("a configured but uninstalled oxlint is reported as missing", () => {
    const repo = createTempRepo({ "package.json": "{}", ".oxlintrc.json": "{}" });
    const plan = planTools(repo.root, DEFAULT_CONFIG);
    expect(plan.tools).toEqual([]);
    expect(plan.missing.map((m) => m.tool)).toEqual(["oxlint"]);
  });

  test("reports only diagnostics introduced by the change (real oxlint)", async () => {
    const repo = oxlintRepo(JSON.stringify({ rules: { "no-debugger": "error" } }));
    const baseline = await snapshotLintBaseline(repo.root, ["oxlint"]);
    expect(baseline.errors).toEqual([]);
    const after = "debugger;\nexport const b = 2;\n";
    repo.write("src/b.ts", after);
    // a.ts already had its debugger statement: editing another line must not surface it.
    const legacy = "debugger;\nexport const a = 1;\n";
    repo.write("src/a.ts", `${legacy}export const more = 1;\n`);
    const result = await runLint({
      root: repo.root,
      tools: ["oxlint"],
      changes: [
        change("src/b.ts", "export const b = 2;\n", after),
        change("src/a.ts", legacy, `${legacy}export const more = 1;\n`),
      ],
      baseline: baseline.fingerprints,
    });
    expect(result.newDiagnostics.map((d) => `${d.tool}:${d.code}:${d.file}:${d.line}`)).toEqual([
      "oxlint:eslint(no-debugger):src/b.ts:1",
    ]);
    expect(result.preexisting).toBe(1);
    expect(result.tools.every((t) => t.ok)).toBe(true);
  }, 60_000);

  test("files the config ignores are not a failure (real oxlint)", async () => {
    const repo = oxlintRepo(JSON.stringify({ ignorePatterns: ["src/b.ts"] }));
    repo.write("src/b.ts", "export const b = 3;\n");
    const result = await runLint({
      root: repo.root,
      tools: ["oxlint"],
      changes: [change("src/b.ts", "export const b = 2;\n", "export const b = 3;\n")],
      baseline: null,
    });
    expect(result.tools[0]?.ok).toBe(true);
    expect(result.newDiagnostics).toEqual([]);
  }, 60_000);

  test("a broken config is reported as a tool error, not thrown (real oxlint)", async () => {
    const repo = oxlintRepo("{bad");
    repo.write("src/b.ts", "export const b = 3;\n");
    const result = await runLint({
      root: repo.root,
      tools: ["oxlint"],
      changes: [change("src/b.ts", "export const b = 2;\n", "export const b = 3;\n")],
      baseline: null,
    });
    expect(result.tools[0]?.ok).toBe(false);
    expect(result.tools[0]?.error).toContain("oxlint");
  }, 60_000);
});
