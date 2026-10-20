import { describe, expect, test } from "vitest";
import type { FileFacts } from "../src/lang/adapter.js";
import { typescriptAdapter } from "../src/lang/typescript/index.js";

function facts(text: string, path = "file.ts"): FileFacts {
  const result = typescriptAdapter.analyze(path, text);
  if (!result.ok) throw new Error(`parse failed: ${result.message}`);
  return result.facts;
}

describe("supports", () => {
  test("accepts TS/JS family extensions and rejects others", () => {
    for (const p of [
      "a.ts",
      "a.tsx",
      "a.mts",
      "a.cts",
      "a.js",
      "a.jsx",
      "a.mjs",
      "a.cjs",
      "a.d.ts",
    ]) {
      expect(typescriptAdapter.supports(p)).toBe(true);
    }
    for (const p of ["a.json", "a.py", "a.md", "Makefile"]) {
      expect(typescriptAdapter.supports(p)).toBe(false);
    }
  });
});

describe("parse errors", () => {
  test("reports the line of a syntax error", () => {
    const result = typescriptAdapter.analyze("a.ts", "const a = 1;\nconst b = ;\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.line).toBe(2);
  });

  test("parses TSX with JSX syntax", () => {
    const f = facts('export const C = () => <div className="x">{1}</div>;\n', "c.tsx");
    expect(f.functions.map((fn) => fn.name)).toEqual(["C"]);
  });
});

describe("tests and assertions", () => {
  const src = `
import { describe, expect, it, test } from "vitest";
describe("auth", () => {
  it("rejects bad token", async () => {
    expect(check("x")).toBe(401);
    expect(await load()).not.toEqual({ ok: true });
    await expect(run()).resolves.toBe(3);
    assert.equal(a, 2);
    assert(ok);
  });
  it.skip("skipped", () => { expect(1).toBe(1); });
  test.todo("later");
  describe.only("focused", () => {
    it("inner", () => {});
  });
});
xit("legacy skip", () => {});
it.skipIf(true)("conditional", () => {});
it.each([1, 2])("each %s", (n) => { expect(n).toBeTruthy(); });
`;
  const f = facts(src, "auth.test.ts");

  test("builds test ids from describe nesting", () => {
    expect(f.tests.map((t) => t.id)).toEqual([
      "auth > rejects bad token",
      "auth > skipped",
      "auth > later",
      "auth > focused > inner",
      "legacy skip",
      "conditional",
      "each %s",
    ]);
  });

  test("extracts modifiers including inherited ones", () => {
    const mods = Object.fromEntries(f.tests.map((t) => [t.id, t.modifier]));
    expect(mods["auth > rejects bad token"]).toBeNull();
    expect(mods["auth > skipped"]).toBe("skip");
    expect(mods["auth > later"]).toBe("todo");
    expect(mods["auth > focused > inner"]).toBe("only");
    expect(mods["legacy skip"]).toBe("skip");
    expect(mods.conditional).toBe("skipIf");
  });

  test("extracts assertions with actual, matcher and expected", () => {
    const t = f.tests.find((x) => x.id === "auth > rejects bad token");
    expect(t?.assertions.map((a) => [a.actual, a.matcher, a.expected])).toEqual([
      ['check("x")', "toBe", "401"],
      ["await load()", "not.toEqual", "{ ok: true }"],
      ["run()", "resolves.toBe", "3"],
      ["a", "assert.equal", "2"],
      ["ok", "assert", null],
    ]);
  });

  test("counts assertions inside each/skip tests", () => {
    expect(f.tests.find((x) => x.id === "each %s")?.assertions).toHaveLength(1);
    expect(f.tests.find((x) => x.id === "auth > skipped")?.assertions).toHaveLength(1);
  });

  test("reports test line numbers", () => {
    expect(f.tests.find((x) => x.id === "auth > rejects bad token")?.line).toBe(4);
  });
});

describe("suppressions", () => {
  test("finds any, as any, as unknown as, and comment directives", () => {
    const f = facts(`
function f(a: any, b: Array<any>): void {}
const x = y as any;
const z = w as unknown as Foo;
const q = <any>r;
// @ts-ignore
const i = 1;
// @ts-expect-error broken types
const j = 2;
/* eslint-disable no-console */
// eslint-disable-next-line no-unused-vars
// biome-ignore lint/suspicious/noExplicitAny: legacy
`);
    expect(f.suppressions.map((s) => [s.kind, s.line])).toEqual([
      ["any", 2],
      ["any", 2],
      ["as-any", 3],
      ["as-unknown-as", 4],
      ["as-any", 5],
      ["ts-ignore", 6],
      ["ts-expect-error", 8],
      ["eslint-disable", 10],
      ["eslint-disable", 11],
      ["biome-ignore", 12],
    ]);
  });

  test("does not confuse an identifier or string named any with the any type", () => {
    const f = facts(
      `const any = 1; const s = "as any"; // talking about any type\nlet t: unknown;\n`,
    );
    expect(f.suppressions).toEqual([]);
  });

  test("finds ts-nocheck", () => {
    expect(facts("// @ts-nocheck\nexport {};\n").suppressions.map((s) => s.kind)).toEqual([
      "ts-nocheck",
    ]);
  });

  test("normalizes line text for comparisons", () => {
    const f = facts("const   x  =  y as any;\r\n");
    expect(f.suppressions[0]?.text).toBe("const x = y as any;");
  });

  test("Function as the test of a conditional type is not a suppression", () => {
    const f = facts(
      "type NotFn<T> = T extends Function ? never : T;\nlet cb: Function;\ntype X<T> = T extends string ? Function : T;\n",
    );
    expect(f.suppressions.map((s) => [s.kind, s.line])).toEqual([
      ["function-type", 2],
      ["function-type", 3],
    ]);
  });

  test("finds directives and TODOs in comments at the end of a line of code", () => {
    const f = facts(
      [
        "export function version(): string {",
        "  return 'N/A' // TODO: add version data",
        "}",
        "run(); // eslint-disable-line no-undef",
        "const x = 1; /* biome-ignore lint: legacy */",
        "",
      ].join("\n"),
    );
    expect(f.suppressions.map((s) => [s.kind, s.line])).toEqual([
      ["eslint-disable", 4],
      ["biome-ignore", 5],
    ]);
    expect(f.todos.map((t) => [t.text, t.line])).toEqual([["TODO: add version data", 2]]);
  });

  test("a TODO quoted as inline code in a comment is a mention, not a TODO", () => {
    const f = facts("/** Reads `return 1; // TODO` too. */\nexport const a = 1; // TODO: real\n");
    expect(f.todos.map((t) => t.text)).toEqual(["TODO: real"]);
  });

  test("text inside JSX that looks like a comment is not one", () => {
    const f = facts(
      "export const A = () => <p>// TODO eslint-disable-line</p>; // real TODO\n",
      "a.tsx",
    );
    expect(f.suppressions).toEqual([]);
    expect(f.todos.map((t) => t.text)).toEqual(["real TODO"]);
  });
});

describe("imports", () => {
  test("collects static, re-export, require, dynamic and type-only imports", () => {
    const f = facts(`
import a from "pkg-a";
import type { B } from "pkg-b";
import { type C } from "./c.js";
export * from "pkg-d";
export { e } from "../e";
const f = require("pkg-f");
const g = await import("pkg-g");
import h = require("pkg-h");
const notLiteral = require(name);
`);
    expect(f.imports.map((i) => [i.specifier, i.typeOnly, i.line])).toEqual([
      ["pkg-a", false, 2],
      ["pkg-b", true, 3],
      ["./c.js", false, 4],
      ["pkg-d", false, 5],
      ["../e", false, 6],
      ["pkg-f", false, 7],
      ["pkg-g", false, 8],
      ["pkg-h", false, 9],
    ]);
  });
});

describe("catches", () => {
  test("classifies catch clauses and promise catch handlers", () => {
    const f = facts(`
try { a(); } catch {}
try { a(); } catch (e) { /* ignore */ }
try { a(); } catch (e) { console.log(e); }
try { a(); } catch (e) { throw new Wrapped(e); }
try { a(); } catch (e) { logger.error(e); return fallback; }
p.catch(() => {});
p.catch((e) => console.error(e));
p.catch((e) => handle(e));
`);
    expect(f.catches.map((c) => [c.line, c.kind])).toEqual([
      [2, "empty"],
      [3, "comment-only"],
      [4, "log-only"],
      [5, "handled"],
      [6, "handled"],
      [7, "empty"],
      [8, "log-only"],
      [9, "handled"],
    ]);
  });
});

describe("functions", () => {
  const f = facts(`
export function full(a: number): number {
  const b = a + 1;
  const c = b * 2;
  if (c > 3) return c;
  return 0;
}
export function gutted(a: number): number {
  return 0;
}
function empty(): void {}
export const arrow = (x: string) => x.length;
export const stub = (): string => { throw new Error("Not implemented"); };
class K {
  method(): boolean { return true; }
}
function local() { return 1; }
export { local };
export default function () { return null; }
`);

  test("collects names, export status and body kinds", () => {
    expect(f.functions.map((fn) => [fn.name, fn.exported, fn.bodyKind])).toEqual([
      ["full", true, "normal"],
      ["gutted", true, "literal-return"],
      ["empty", false, "empty"],
      ["arrow", true, "normal"],
      ["stub", true, "throw-not-implemented"],
      ["K.method", false, "literal-return"],
      ["local", true, "literal-return"],
      ["default", true, "literal-return"],
    ]);
  });

  test("counts statements recursively", () => {
    expect(f.functions.find((fn) => fn.name === "full")?.statementCount).toBe(5);
    expect(f.functions.find((fn) => fn.name === "gutted")?.statementCount).toBe(1);
  });

  test("produces normalized body tokens", () => {
    const tokens = f.functions.find((fn) => fn.name === "arrow")?.tokens ?? [];
    expect(tokens).toEqual(["x", ".", "length"]);
  });

  test("records not-implemented throws anywhere", () => {
    const g = facts(`function a() { if (x) { throw new Error("TODO: implement"); } return 1; }\n`);
    expect(g.notImplemented.map((n) => n.line)).toEqual([1]);
  });
});

describe("todos", () => {
  test("finds TODO-like comments and flags implement-style ones", () => {
    const f = facts(`
// TODO: refactor later
// FIXME broken on windows
/* TODO: implement validation */
// placeholder implementation
const todo = "TODO in a string";
`);
    expect(f.todos.map((t) => [t.line, t.implement])).toEqual([
      [2, false],
      [3, false],
      [4, true],
      [5, true],
    ]);
  });
});

describe("literals", () => {
  test("flattens object literal key paths in config-like files", () => {
    const f = facts(
      `
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    passWithNoTests: true,
    exclude: ["dist", "src/broken.test.ts"],
    coverage: { thresholds: { lines: 80 } },
  },
});
`,
      "vitest.config.ts",
    );
    expect(f.literals.map((l) => [l.path, l.value])).toEqual([
      ["test.passWithNoTests", true],
      ["test.exclude[0]", "dist"],
      ["test.exclude[1]", "src/broken.test.ts"],
      ["test.coverage.thresholds.lines", 80],
    ]);
  });

  test("handles eslint flat config arrays and quoted keys", () => {
    const f = facts(
      `export default [{ rules: { "no-console": "off", eqeqeq: ["error", "always"] } }];\n`,
      "eslint.config.js",
    );
    expect(f.literals.map((l) => [l.path, l.value])).toEqual([
      ["[0].rules.no-console", "off"],
      ["[0].rules.eqeqeq[0]", "error"],
      ["[0].rules.eqeqeq[1]", "always"],
    ]);
  });
});

describe("import names and exports", () => {
  test("records imported binding names", () => {
    const f = facts(
      `import def, { a, b as c } from "./m";\nimport * as ns from "./n";\nconst { x } = require("./r");\n`,
    );
    expect(f.imports.map((i) => [i.specifier, i.names])).toEqual([
      ["./m", ["def", "a", "c"]],
      ["./n", ["ns"]],
      ["./r", []],
    ]);
  });

  test("collects every exported name", () => {
    const f = facts(`
export const a = 1;
export function b() {}
export class C {}
export interface I {}
export type T = string;
export enum E { X }
const d = 2;
export { d, d as e };
export default function () {}
module.exports = { f, g: h };
`);
    expect([...f.exports].sort()).toEqual(
      ["C", "E", "I", "T", "a", "b", "d", "default", "e", "f", "g"].sort(),
    );
  });
});

describe("suppressions through parentheses", () => {
  test("detects a parenthesized double cast and a parenthesized as any", () => {
    const f = facts("const a = ({} as unknown) as Foo;\nconst b = ((x) as any);\n");
    expect(f.suppressions.map((s) => s.kind)).toEqual(["as-unknown-as", "as-any"]);
  });
});
