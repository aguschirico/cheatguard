import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/index.js";
import type { FileFacts } from "../src/lang/adapter.js";
import { typescriptAdapter } from "../src/lang/typescript/index.js";
import { scriptKindFor } from "../src/lang/typescript/parse.js";
import { detectTools } from "../src/lint/detect.js";
import { runTool, tsconfigProjects } from "../src/lint/run.js";

function facts(text: string, path: string): FileFacts {
  const r = typescriptAdapter.analyze(path, text);
  if (!r.ok) throw new Error(r.message);
  return r.facts;
}

describe("parse", () => {
  test("picks the script kind from the extension", () => {
    expect(scriptKindFor("a.tsx")).toBe(ts.ScriptKind.TSX);
    expect(scriptKindFor("a.jsx")).toBe(ts.ScriptKind.JSX);
    expect(scriptKindFor("a.mjs")).toBe(ts.ScriptKind.JS);
    expect(scriptKindFor("a.cts")).toBe(ts.ScriptKind.TS);
  });
});

describe("config literals", () => {
  test("handles negative numbers, satisfies, parentheses, computed keys and null", () => {
    const f = facts(
      `export default ({ a: -1, ["b"]: null, c: { d: 1 } satisfies object, e: [[1, "x"]], f: someCall(), ...spread }) as const;\n`,
      "vitest.config.ts",
    );
    expect(f.literals.map((l) => [l.path, l.value])).toEqual([
      ["a", -1],
      ["b", null],
      ["c.d", 1],
      ["e[0][0]", 1],
      ["e[0][1]", "x"],
    ]);
  });

  test("ordinary source files do not get literal extraction", () => {
    expect(facts(`export const config = { strict: false };\n`, "src/config.ts").literals).toEqual(
      [],
    );
  });
});

describe("exports and functions", () => {
  test("covers CommonJS exports and destructured exports", () => {
    const f = facts(
      `exports.one = () => 1;\nmodule.exports.two = function two() { return 2; };\nexport const { x, y: [z] } = obj;\nexport * as ns from "./ns";\n`,
      "a.js",
    );
    expect([...f.exports].sort()).toEqual(["ns", "one", "two", "x", "z"].sort());
  });

  test("class property arrows and object methods are functions", () => {
    const f = facts(
      `class A {\n  handle = () => { const x = 1; return x; };\n}\nconst o = { run() { return 1; } };\n`,
      "a.ts",
    );
    expect(f.functions.map((fn) => fn.name)).toEqual(["A.handle", "run"]);
  });
});

describe("detectTools", () => {
  test("finds eslint configured in package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-detect-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ eslintConfig: { rules: {} } }));
    mkdirSync(join(dir, "node_modules", "eslint", "bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "eslint", "bin", "eslint.js"), "");
    expect(detectTools(dir, parseConfig({}))).toEqual(["eslint"]);
    expect(detectTools(dir, parseConfig({ lint: { tools: ["tsc"] } }))).toEqual([]);
  });

  test("a broken package.json does not crash detection", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-detect-"));
    writeFileSync(join(dir, "package.json"), "{ nope");
    mkdirSync(join(dir, "node_modules", "eslint", "bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "eslint", "bin", "eslint.js"), "");
    expect(detectTools(dir, parseConfig({}))).toEqual([]);
  });
});

describe("runTool", () => {
  test("reports a missing tool instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-run-"));
    expect(runTool(dir, "tsc", "all").error).toContain("not installed");
  });

  test("solution-style tsconfigs expand to their references", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-run-"));
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        files: [],
        references: [{ path: "./packages/a" }, { path: "./packages/b/tsconfig.build.json" }],
      }),
    );
    expect(tsconfigProjects(dir)).toEqual([
      "packages/a/tsconfig.json",
      "./packages/b/tsconfig.build.json",
    ]);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
    expect(tsconfigProjects(dir)).toEqual(["tsconfig.json"]);
    expect(tsconfigProjects(mkdtempSync(join(tmpdir(), "cg-run-")))).toEqual([]);
  });
});
