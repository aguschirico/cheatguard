import { describe, expect, test } from "vitest";
import { stubLeft } from "../../src/rules/stub-left.js";
import { swallowedError } from "../../src/rules/swallowed-error.js";
import { typeSuppression } from "../../src/rules/type-suppression.js";
import { run } from "../helpers/rules.js";

// Repros from the adversarial review: type and coverage escapes that passed silently.
const SRC = `export function add(a: number, b: number): number {
  return a + b;
}
`;
const P = "src/add.ts";

describe("type-suppression: escapes beyond any and ts-ignore", () => {
  test.each([
    ["as never", SRC.replace("return a + b;", `return ("x" as never) + a + b;`), "as never"],
    ["<never> assertion", SRC.replace("return a + b;", `return (<never>"x") + a + b;`), "as never"],
    [
      "angle double cast",
      SRC.replace("return a + b;", `return <number><unknown>"x";`),
      "double cast",
    ],
    [
      "mixed double cast",
      SRC.replace("return a + b;", `return <number>("x" as unknown);`),
      "double cast",
    ],
    ["Function type", SRC.replace("b: number)", "b: number, cb?: Function)"), "Function"],
    [
      "v8 ignore",
      SRC.replace("  return a + b;", "  /* v8 ignore next */\n  return a + b;"),
      "coverage",
    ],
    [
      "istanbul ignore",
      SRC.replace("  return a + b;", "  /* istanbul ignore next */\n  return a + b;"),
      "coverage",
    ],
    [
      "c8 ignore",
      SRC.replace("  return a + b;", "  /* c8 ignore start */\n  return a + b;"),
      "coverage",
    ],
    [
      "oxlint-disable",
      SRC.replace("  return a + b;", "  // oxlint-disable-next-line\n  return a + b;"),
      "lint",
    ],
  ])("%s is blocked", (_label, after, word) => {
    const vs = run(typeSuppression, [{ path: P, before: SRC, after }]);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.severity).toBe("block");
    expect(vs[0]?.detail).toContain(word);
  });

  test.each([
    ["shorthand", `declare module "left-pad";\n`],
    ["wildcard", `declare module "*";\n`],
  ])("an untyped %s ambient module is blocked", (_label, text) => {
    const vs = run(typeSuppression, [{ path: "src/shim.d.ts", after: text }]);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.detail).toContain("untyped module");
  });

  test("a typed asset module declaration is fine", () => {
    const text = `declare module "*.svg" {\n  const url: string;\n  export default url;\n}\n`;
    expect(run(typeSuppression, [{ path: "src/assets.d.ts", after: text }])).toEqual([]);
  });

  test("a never return type is not a cast", () => {
    const after = `${SRC}export function fail(): never {\n  throw new Error("boom");\n}\n`;
    expect(run(typeSuppression, [{ path: P, before: SRC, after }])).toEqual([]);
  });

  test("ts-ignore and ts-nocheck block in test files; casts and expect-error only warn", () => {
    const T = "src/add.test.ts";
    const base = `import { add } from "./add";\ntest("adds", () => {\n  expect(add(1, 2)).toBe(3);\n});\n`;
    const ignore = run(typeSuppression, [
      { path: T, before: base, after: base.replace("  expect", "  // @ts-ignore\n  expect") },
    ]);
    expect(ignore.map((v) => v.severity)).toEqual(["block"]);
    const nocheck = run(typeSuppression, [
      { path: T, before: base, after: `// @ts-nocheck\n${base}` },
    ]);
    expect(nocheck.map((v) => v.severity)).toEqual(["block"]);
    const expectError = run(typeSuppression, [
      {
        path: T,
        before: base,
        after: base.replace("  expect", "  // @ts-expect-error invalid input\n  expect"),
      },
    ]);
    expect(expectError.map((v) => v.severity)).toEqual(["warn"]);
    const cast = run(typeSuppression, [
      { path: T, before: base, after: base.replace("add(1, 2)", "add(1 as any, 2)") },
    ]);
    expect(cast.map((v) => v.severity)).toEqual(["warn"]);
  });
});

describe("stub-left and swallowed-error: placeholders the review found", () => {
  test("throw new Error('TBD') is a stub", () => {
    const after = SRC.replace("return a + b;", `throw new Error("TBD");`);
    const vs = run(stubLeft, [{ path: P, before: SRC, after }]);
    expect(vs.length).toBeGreaterThanOrEqual(1);
  });

  test(".catch(() => undefined) swallows the error", () => {
    const base = `export async function load(f: () => Promise<number>) {\n  return f();\n}\n`;
    const after = base.replace("return f();", "return f().catch(() => undefined);");
    const vs = run(swallowedError, [{ path: P, before: base, after }]);
    expect(vs).toHaveLength(1);
  });

  test(".catch(() => null) swallows the error", () => {
    const base = `export async function load(f: () => Promise<number>) {\n  return f();\n}\n`;
    const after = base.replace("return f();", "return f().catch(() => null);");
    expect(run(swallowedError, [{ path: P, before: base, after }])).toHaveLength(1);
  });
});

describe("type-suppression: any swaps", () => {
  test("a new any is reported even when the same change removes unrelated ones", () => {
    const before = `export const a: any = 1;\nexport const b: any = 2;\nexport function f(x: string): number {\n  return x.length;\n}\n`;
    const after = `export const a = 1;\nexport const b = 2;\nexport function f(x: string): any {\n  return x.length;\n}\n`;
    const vs = run(typeSuppression, [{ path: "src/s.ts", before, after }]);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.line).toBe(3);
  });

  test("editing a line that already held the suppression is still not reported", () => {
    const before = `export const value = load(input as any);\n`;
    const after = `export const value = load(otherInput as any);\n`;
    expect(run(typeSuppression, [{ path: "src/s.ts", before, after }])).toEqual([]);
  });
});
