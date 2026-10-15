import { describe, expect, test } from "vitest";
import { typeSuppression } from "../../src/rules/type-suppression.js";
import { run } from "../helpers/rules.js";

const SRC = `export function parse(input: string): number {
  const value = Number(input);
  return value;
}
`;
const P = "src/parse.ts";

describe("type-suppression: positives", () => {
  test.each([
    ["explicit any parameter", SRC.replace("input: string", "input: any"), "any"],
    ["as any cast", SRC.replace("Number(input)", "Number(input as any)"), "as any"],
    [
      "as unknown as",
      SRC.replace("return value;", "return value as unknown as number;"),
      "as unknown as",
    ],
    [
      "@ts-ignore",
      SRC.replace("  return value;", "  // @ts-ignore\n  return value;"),
      "@ts-ignore",
    ],
    [
      "@ts-expect-error",
      SRC.replace("  return value;", "  // @ts-expect-error\n  return value;"),
      "@ts-expect-error",
    ],
    ["@ts-nocheck", `// @ts-nocheck\n${SRC}`, "@ts-nocheck"],
    [
      "eslint-disable-next-line",
      SRC.replace("  return value;", "  // eslint-disable-next-line\n  return value;"),
      "eslint-disable",
    ],
    ["file-level eslint-disable", `/* eslint-disable */\n${SRC}`, "eslint-disable"],
    [
      "biome-ignore",
      SRC.replace("  return value;", "  // biome-ignore lint: x\n  return value;"),
      "biome-ignore",
    ],
    ["angle-bracket any", SRC.replace("Number(input)", "Number(<any>input)"), "as any"],
  ])("flags %s", (_name, after, label) => {
    const vs = run(typeSuppression, [{ path: P, before: SRC, after }]);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.severity).toBe("block");
    expect(vs[0]?.detail).toContain(label);
  });

  test("flags any in a brand-new file", () => {
    const vs = run(typeSuppression, [{ path: "src/new.ts", after: "export const x: any = 1;\n" }]);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.line).toBe(1);
  });

  test("reports one violation per new suppression", () => {
    const after = SRC.replace("input: string", "input: any").replace(
      "Number(input)",
      "Number(input as any)",
    );
    expect(run(typeSuppression, [{ path: P, before: SRC, after }])).toHaveLength(2);
  });
});

describe("type-suppression: negatives", () => {
  const WITH_ANY = SRC.replace("input: string", "input: any");

  test("an existing suppression that moved is not new", () => {
    const after = `\n\n${WITH_ANY}`;
    expect(run(typeSuppression, [{ path: P, before: WITH_ANY, after }])).toEqual([]);
  });

  test("editing a line that already had any is not new", () => {
    const after = WITH_ANY.replace("input: any", "input: any, radix = 10");
    expect(run(typeSuppression, [{ path: P, before: WITH_ANY, after }])).toEqual([]);
  });

  test("removing a suppression is fine", () => {
    expect(run(typeSuppression, [{ path: P, before: WITH_ANY, after: SRC }])).toEqual([]);
  });

  test("unknown is fine", () => {
    expect(
      run(typeSuppression, [
        { path: P, before: SRC, after: SRC.replace("input: string", "input: unknown") },
      ]),
    ).toEqual([]);
  });

  test("a single as unknown is fine", () => {
    expect(
      run(typeSuppression, [
        { path: P, before: SRC, after: SRC.replace("Number(input)", "Number(input as unknown)") },
      ]),
    ).toEqual([]);
  });

  test("the word any in a string or comment is fine", () => {
    const after = SRC.replace(
      "  return value;",
      '  // accepts any input\n  const label = "as any";\n  return value;',
    );
    expect(run(typeSuppression, [{ path: P, before: SRC, after }])).toEqual([]);
  });

  test("deleted files are ignored", () => {
    expect(run(typeSuppression, [{ path: P, before: WITH_ANY, after: null }])).toEqual([]);
  });

  test("non-code files are ignored", () => {
    expect(
      run(typeSuppression, [{ path: "README.md", before: "a", after: "// @ts-ignore any" }]),
    ).toEqual([]);
  });

  test("files that fail to parse are skipped", () => {
    expect(
      run(typeSuppression, [{ path: P, before: SRC, after: `${SRC}\nconst x: any = ;` }]),
    ).toEqual([]);
  });

  test("suppressions in test files are warnings, not blocks", () => {
    const vs = run(typeSuppression, [{ path: "src/parse.test.ts", before: SRC, after: WITH_ANY }]);
    expect(vs.map((v) => v.severity)).toEqual(["warn"]);
  });
});
