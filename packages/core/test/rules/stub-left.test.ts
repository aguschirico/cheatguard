import { describe, expect, test } from "vitest";
import { stubLeft } from "../../src/rules/stub-left.js";
import { run } from "../helpers/rules.js";

const SRC = `export function total(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}
`;
const P = "src/total.ts";

describe("stub-left: positives", () => {
  test("flags a new not-implemented throw", () => {
    const after = `${SRC}export function avg(items: number[]): number {\n  throw new Error("Not implemented");\n}\n`;
    const vs = run(stubLeft, [{ path: P, before: SRC, after }]);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.severity).toBe("block");
    expect(vs[0]?.line).toBe(9);
  });

  test("flags a body gutted to a literal return", () => {
    const after = `export function total(items: number[]): number {\n  return 0;\n}\n`;
    const vs = run(stubLeft, [{ path: P, before: SRC, after }]);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.detail).toContain("total");
  });

  test("flags a body gutted to empty", () => {
    const before = SRC.replace("): number {", "): void {").replace(
      "  return sum;\n",
      "  console.log(sum);\n",
    );
    const after = `export function total(items: number[]): void {}\n`;
    expect(run(stubLeft, [{ path: P, before, after }])).toHaveLength(1);
  });

  test("flags a body replaced by a not-implemented throw (single violation)", () => {
    const after = `export function total(items: number[]): number {\n  throw new Error("TODO: implement");\n}\n`;
    expect(run(stubLeft, [{ path: P, before: SRC, after }])).toHaveLength(1);
  });

  test("blocks a new TODO: implement comment", () => {
    const after = SRC.replace("  let sum = 0;", "  // TODO: implement discounts\n  let sum = 0;");
    const vs = run(stubLeft, [{ path: P, before: SRC, after }]);
    expect(vs.map((v) => v.severity)).toEqual(["block"]);
  });

  test("blocks a placeholder comment", () => {
    const after = SRC.replace(
      "  let sum = 0;",
      "  // placeholder implementation for now\n  let sum = 0;",
    );
    expect(run(stubLeft, [{ path: P, before: SRC, after }]).map((v) => v.severity)).toEqual([
      "block",
    ]);
  });

  test("warns on a generic new TODO", () => {
    const after = SRC.replace("  let sum = 0;", "  // TODO: use reduce\n  let sum = 0;");
    expect(run(stubLeft, [{ path: P, before: SRC, after }]).map((v) => v.severity)).toEqual([
      "warn",
    ]);
  });

  test("flags a NotImplementedError class", () => {
    const after = SRC.replace(
      "  return sum;",
      "  if (sum < 0) throw new NotImplementedError();\n  return sum;",
    );
    expect(run(stubLeft, [{ path: P, before: SRC, after }])).toHaveLength(1);
  });

  test("flags a gutted method", () => {
    const before = `class Cart {\n  total(): number {\n    let s = 0;\n    for (const i of this.items) s += i;\n    return s;\n  }\n}\n`;
    const after = `class Cart {\n  total(): number {\n    return 0;\n  }\n}\n`;
    expect(run(stubLeft, [{ path: P, before, after }])[0]?.detail).toContain("Cart.total");
  });

  test("flags stubs in brand-new files", () => {
    expect(
      run(stubLeft, [
        {
          path: "src/new.ts",
          after: `export function f(): number {\n  throw new Error("not implemented");\n}\n`,
        },
      ]),
    ).toHaveLength(1);
  });
});

describe("stub-left: negatives", () => {
  test("a new small function returning a literal is fine", () => {
    const after = `${SRC}export function zero(): number {\n  return 0;\n}\n`;
    expect(run(stubLeft, [{ path: P, before: SRC, after }])).toEqual([]);
  });

  test("an existing stub that moved is fine", () => {
    const before = `${SRC}// TODO: implement avg\n`;
    const after = `// TODO: implement avg\n${SRC}`;
    expect(run(stubLeft, [{ path: P, before, after }])).toEqual([]);
  });

  test("refactoring a body to a shorter real implementation is fine", () => {
    const after = `export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n`;
    expect(run(stubLeft, [{ path: P, before: SRC, after }])).toEqual([]);
  });

  test("removing a TODO is fine", () => {
    const before = SRC.replace("  let sum = 0;", "  // TODO: implement\n  let sum = 0;");
    expect(run(stubLeft, [{ path: P, before, after: SRC }])).toEqual([]);
  });

  test("an error message that merely mentions implementation is fine", () => {
    const after = SRC.replace(
      "  return sum;",
      '  if (sum < 0) throw new Error("negative totals are invalid");\n  return sum;',
    );
    expect(run(stubLeft, [{ path: P, before: SRC, after }])).toEqual([]);
  });

  test("a comment saying the class implements an interface is fine", () => {
    const after = `// implements the Totaler interface\n${SRC}`;
    expect(run(stubLeft, [{ path: P, before: SRC, after }])).toEqual([]);
  });

  test("deleting a function is fine", () => {
    expect(run(stubLeft, [{ path: P, before: SRC, after: "export {};\n" }])).toEqual([]);
  });

  test("deleted files are ignored", () => {
    expect(run(stubLeft, [{ path: P, before: SRC, after: null }])).toEqual([]);
  });

  test("abstract-like small functions that were already literal are fine", () => {
    const before = `export function flag(): boolean {\n  return false;\n}\n`;
    const after = `export function flag(): boolean {\n  return true;\n}\n`;
    expect(run(stubLeft, [{ path: P, before, after }])).toEqual([]);
  });

  test("TODO text inside strings is fine", () => {
    const after = SRC.replace(
      "  let sum = 0;",
      '  const label = "TODO: implement";\n  let sum = 0;',
    );
    expect(run(stubLeft, [{ path: P, before: SRC, after }])).toEqual([]);
  });
});
