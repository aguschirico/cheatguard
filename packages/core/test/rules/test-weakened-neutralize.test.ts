import { describe, expect, test } from "vitest";
import { testWeakened } from "../../src/rules/test-weakened.js";
import { run } from "../helpers/rules.js";

// Repros from the adversarial review: one-line edits that turn a test off without deleting it.
const T = "src/sum.test.ts";
const SRC = "export function sum(a: number, b: number) { return a + b; }\n";
const BASE = `import { describe, expect, it } from "vitest";
import { sum } from "./sum";

describe("sum", () => {
  it("adds two numbers", () => {
    expect(sum(2, 2)).toBe(4);
    expect(sum(-1, 1)).toBe(0);
  });
});
`;

function check(
  after: string,
  extra: Array<{ path: string; before?: string; after?: string }> = [],
) {
  return run(testWeakened, [{ path: T, before: BASE, after }, ...extra], {
    files: { "src/sum.ts": SRC },
  });
}

const blocks = (vs: ReturnType<typeof check>) => vs.filter((v) => v.severity === "block");

describe("test-weakened: modifiers that disable a test", () => {
  test.each([
    ["it.fails", BASE.replace(`it("adds`, `it.fails("adds`), "fails"],
    ["it.failing", BASE.replace(`it("adds`, `it.failing("adds`), "fails"],
    ["it.runIf(false)", BASE.replace(`it("adds`, `it.runIf(false)("adds`), "runIf"],
    ["it.runIf(cond)", BASE.replace(`it("adds`, `it.runIf(process.env.CI)("adds`), "runIf"],
    [
      "describe.runIf(false)",
      BASE.replace(`describe("sum"`, `describe.runIf(false)("sum"`),
      "runIf",
    ],
    ["it.skipIf(cond)", BASE.replace(`it("adds`, `it.skipIf(!process.env.CI)("adds`), "skipIf"],
    ["it.each([])", BASE.replace(`it("adds`, `it.each([])("adds`), "empty table"],
    ["it.for([])", BASE.replace(`it("adds`, `it.for([])("adds`), "empty table"],
  ])("%s is blocked", (_label, after, word) => {
    const vs = blocks(check(after));
    expect(vs).toHaveLength(1);
    expect(vs[0]?.detail).toContain(word);
  });

  test("runIf(true) and skipIf(false) are no-ops", () => {
    expect(check(BASE.replace(`it("adds`, `it.runIf(true)("adds`))).toEqual([]);
    expect(check(BASE.replace(`it("adds`, `it.skipIf(false)("adds`))).toEqual([]);
  });

  test("a non-empty each table is not a skip", () => {
    const after = BASE.replace(`it("adds`, `it.each([[1, 2]])("adds`);
    expect(check(after)).toEqual([]);
  });
});

describe("test-weakened: assertions that can no longer run", () => {
  test("an early return before the assertions is blocked", () => {
    const after = BASE.replace(
      `  it("adds two numbers", () => {\n`,
      `  it("adds two numbers", () => {\n    return;\n`,
    );
    const vs = blocks(check(after));
    expect(vs).toHaveLength(1);
    expect(vs[0]?.detail).toMatch(/2 to 0 assertions/);
  });

  test("assertions after a throw are not counted", () => {
    const after = BASE.replace(
      `    expect(sum(-1, 1)).toBe(0);\n`,
      `    throw new Error("x");\n    expect(sum(-1, 1)).toBe(0);\n`,
    );
    expect(blocks(check(after))[0]?.detail).toMatch(/2 to 1 assertions/);
  });

  test("assertions under a constant-false condition are blocked", () => {
    const after = BASE.replace(
      `    expect(sum(2, 2)).toBe(4);\n    expect(sum(-1, 1)).toBe(0);\n`,
      `    if (false) {\n      expect(sum(2, 2)).toBe(4);\n      expect(sum(-1, 1)).toBe(0);\n    }\n`,
    );
    expect(blocks(check(after))).toHaveLength(1);
  });

  test("assertions moved into a function that is never called are blocked", () => {
    const after = BASE.replace(
      `    expect(sum(2, 2)).toBe(4);\n    expect(sum(-1, 1)).toBe(0);\n`,
      `    const verify = () => {\n      expect(sum(2, 2)).toBe(4);\n      expect(sum(-1, 1)).toBe(0);\n    };\n`,
    );
    expect(blocks(check(after))).toHaveLength(1);
  });

  test("assertions in a helper that is called still count", () => {
    const after = BASE.replace(
      `    expect(sum(2, 2)).toBe(4);\n    expect(sum(-1, 1)).toBe(0);\n`,
      `    const verify = () => {\n      expect(sum(2, 2)).toBe(4);\n      expect(sum(-1, 1)).toBe(0);\n    };\n    verify();\n`,
    );
    expect(check(after)).toEqual([]);
  });

  test("assertions in callbacks passed to a call still count", () => {
    const after = BASE.replace(
      `    expect(sum(2, 2)).toBe(4);\n    expect(sum(-1, 1)).toBe(0);\n`,
      `    [1].forEach(() => {\n      expect(sum(2, 2)).toBe(4);\n      expect(sum(-1, 1)).toBe(0);\n    });\n`,
    );
    expect(check(after)).toEqual([]);
  });

  test("assertions newly wrapped in a runtime condition warn", () => {
    const after = BASE.replace(
      `    expect(sum(2, 2)).toBe(4);\n    expect(sum(-1, 1)).toBe(0);\n`,
      `    if (Math.random() > 2) {\n      expect(sum(2, 2)).toBe(4);\n      expect(sum(-1, 1)).toBe(0);\n    }\n`,
    );
    const vs = check(after);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.severity).toBe("warn");
    expect(vs[0]?.detail).toContain("conditional");
  });

  test("a condition that was already there is not reported", () => {
    const base = BASE.replace(
      `    expect(sum(2, 2)).toBe(4);\n`,
      `    if (process.env.CI) {\n      expect(sum(2, 2)).toBe(4);\n    }\n`,
    );
    const after = base.replace(
      `expect(sum(-1, 1)).toBe(0)`,
      `expect(sum(-1, 1)).toBe(0);\n    expect(sum(1, 1)).toBe(2)`,
    );
    expect(
      run(testWeakened, [{ path: T, before: base, after }], { files: { "src/sum.ts": SRC } }),
    ).toEqual([]);
  });
});

describe("test-weakened: assertions that check nothing", () => {
  test("a tautology replacing a real assertion is blocked", () => {
    const after = BASE.replace(`expect(sum(2, 2)).toBe(4)`, `expect(4).toBe(4)`).replace(
      `expect(sum(-1, 1)).toBe(0)`,
      `expect(0).toBe(0)`,
    );
    const vs = blocks(check(after));
    expect(vs).toHaveLength(1);
    expect(vs[0]?.detail).toMatch(/2 to 0 assertions/);
  });

  test.each([
    ["toBeDefined", `expect(sum(2, 2)).toBeDefined()`],
    ["toBeTruthy", `expect(sum(2, 2)).toBeTruthy()`],
    ["toBeTypeOf", `expect(sum(2, 2)).toBeTypeOf("number")`],
    ["not.toBe", `expect(sum(2, 2)).not.toBe(5)`],
    ["expect.anything", `expect(sum(2, 2)).toEqual(expect.anything())`],
    ["expect.any", `expect(sum(2, 2)).toEqual(expect.any(Number))`],
  ])("weakening the matcher to %s is blocked", (_label, replacement) => {
    const after = BASE.replace(`expect(sum(2, 2)).toBe(4)`, replacement);
    const vs = blocks(check(after));
    expect(vs).toHaveLength(1);
    expect(vs[0]?.detail).toContain("weaker");
  });

  test("toBe → toEqual with the same value is fine", () => {
    expect(
      check(BASE.replace(`expect(sum(2, 2)).toBe(4)`, `expect(sum(2, 2)).toEqual(4)`)),
    ).toEqual([]);
  });

  test("a weaker matcher warns when the code under test changed too", () => {
    const after = BASE.replace(`expect(sum(2, 2)).toBe(4)`, `expect(sum(2, 2)).toBeDefined()`);
    const vs = check(after, [
      { path: "src/sum.ts", before: SRC, after: SRC.replace("a + b", "a + b + 0") },
    ]);
    expect(vs.map((v) => v.severity)).toEqual(["warn"]);
  });
});

describe("test-weakened: mocking the module under test", () => {
  test("a new vi.mock of a module the test asserts on warns", () => {
    const after = BASE.replace(
      `import { sum } from "./sum";\n`,
      `import { sum } from "./sum";\nvi.mock("./sum", () => ({ sum: () => 4 }));\n`,
    );
    const vs = check(after);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.severity).toBe("warn");
    expect(vs[0]?.detail).toContain("mock");
  });

  test("mocking a dependency the test does not import from is fine", () => {
    const after = BASE.replace(
      `import { sum } from "./sum";\n`,
      `import { sum } from "./sum";\nvi.mock("./logger");\n`,
    );
    expect(check(after)).toEqual([]);
  });
});

describe("test-weakened: test files moved out of the runner's reach", () => {
  test.each([
    ["src/sum.test.ts.bak"],
    ["src/sum.test.md"],
    ["src/sum.disabled.ts"],
    ["fixtures/sum.ts"],
  ])("renaming the test file to %s is blocked", (target) => {
    const vs = run(testWeakened, [{ path: target, oldPath: T, before: BASE, after: BASE }], {
      files: { "src/sum.ts": SRC },
    });
    expect(blocks(vs)).toHaveLength(1);
    expect(vs[0]?.detail).toContain("no longer runs");
  });

  test("renaming to another test file name is fine", () => {
    const vs = run(
      testWeakened,
      [{ path: "src/add.test.ts", oldPath: T, before: BASE, after: BASE }],
      {
        files: { "src/sum.ts": SRC },
      },
    );
    expect(vs).toEqual([]);
  });

  test("moving a test file away together with its subject is fine", () => {
    const vs = run(
      testWeakened,
      [
        { path: "attic/sum.test.ts.bak", oldPath: T, before: BASE, after: BASE },
        { path: "src/sum.ts", before: SRC, after: null },
      ],
      {},
    );
    expect(vs).toEqual([]);
  });
});

describe("test-weakened: whole test files moved", () => {
  test("deleting a test file whose tests all reappear in another test file is a move", () => {
    const vs = run(
      testWeakened,
      [
        { path: T, before: BASE, after: null },
        { path: "src/sum.spec.ts", before: null, after: BASE },
      ],
      { files: { "src/sum.ts": SRC } },
    );
    expect(vs).toEqual([]);
  });

  test("a move that drops assertions on the way is still reported", () => {
    const vs = run(
      testWeakened,
      [
        { path: T, before: BASE, after: null },
        {
          path: "src/sum.spec.ts",
          before: null,
          after: BASE.replace("    expect(sum(-1, 1)).toBe(0);\n", ""),
        },
      ],
      { files: { "src/sum.ts": SRC } },
    );
    expect(vs.length).toBeGreaterThan(0);
  });
});

test("a test moved to another file without any assertion is a deletion", () => {
  const vs = run(
    testWeakened,
    [
      { path: T, before: BASE, after: null },
      { path: "src/sum.spec.ts", before: null, after: BASE.replace(/ {4}expect\(.*\n/g, "") },
    ],
    { files: { "src/sum.ts": SRC } },
  );
  expect(vs.map((v) => v.severity)).toContain("block");
});
