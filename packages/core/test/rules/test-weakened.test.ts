import { describe, expect, test } from "vitest";
import { testWeakened } from "../../src/rules/test-weakened.js";
import { run } from "../helpers/rules.js";

const BASE = `import { describe, expect, it } from "vitest";
import { login, logout } from "../src/auth";

describe("auth", () => {
  it("rejects bad token", () => {
    expect(login("bad")).toBe(401);
    expect(login("")).toBe(401);
    expect(login(null)).toBe(400);
  });

  it("logs out", () => {
    expect(logout()).toBe(true);
  });
});
`;

const T = "test/auth.test.ts";
const SRC_BEFORE =
  "export function login(t: string | null) { return 401; }\nexport function logout() { return true; }\n";

const kinds = (vs: ReturnType<typeof run>) => vs.map((v) => [v.severity, v.detail.split(":")[0]]);

describe("test-weakened: positives", () => {
  test("flags a deleted test", () => {
    const after = BASE.replace(/\n {2}it\("logs out"[\s\S]*?\n {2}}\);\n/, "\n");
    const vs = run(testWeakened, [{ path: T, before: BASE, after }]);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.severity).toBe("block");
    expect(vs[0]?.detail).toContain("auth > logs out");
  });

  test("flags fewer assertions", () => {
    const after = BASE.replace(
      `    expect(login("")).toBe(401);\n    expect(login(null)).toBe(400);\n`,
      "",
    );
    const vs = run(testWeakened, [{ path: T, before: BASE, after }]);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.detail).toMatch(/3 .*1/);
    expect(vs[0]?.line).toBe(5);
  });

  test("flags a test that lost all assertions", () => {
    const after = BASE.replace(`    expect(logout()).toBe(true);\n`, "");
    expect(run(testWeakened, [{ path: T, before: BASE, after }])).toHaveLength(1);
  });

  test("flags .skip added to an existing test", () => {
    const after = BASE.replace(`it("logs out"`, `it.skip("logs out"`);
    const vs = run(testWeakened, [{ path: T, before: BASE, after }]);
    expect(vs.map((v) => v.detail)).toEqual([expect.stringContaining("skip")]);
  });

  test("flags .only added to an existing test", () => {
    const after = BASE.replace(`it("logs out"`, `it.only("logs out"`);
    expect(run(testWeakened, [{ path: T, before: BASE, after }])[0]?.detail).toContain("only");
  });

  test("flags xit replacing it", () => {
    const after = BASE.replace(`it("logs out"`, `xit("logs out"`);
    expect(run(testWeakened, [{ path: T, before: BASE, after }])).toHaveLength(1);
  });

  test("flags a test turned into todo", () => {
    const after = BASE.replace(
      / {2}it\("logs out", \(\) => {\n {4}expect\(logout\(\)\).toBe\(true\);\n {2}}\);/,
      `  it.todo("logs out");`,
    );
    const vs = run(testWeakened, [{ path: T, before: BASE, after }]);
    expect(vs.some((v) => v.detail.includes("todo"))).toBe(true);
  });

  test("flags describe.skip on a suite", () => {
    const after = BASE.replace(`describe("auth"`, `describe.skip("auth"`);
    expect(run(testWeakened, [{ path: T, before: BASE, after }]).length).toBeGreaterThanOrEqual(1);
  });

  test("flags it.skipIf(true)", () => {
    const after = BASE.replace(`it("logs out"`, `it.skipIf(true)("logs out"`);
    expect(run(testWeakened, [{ path: T, before: BASE, after }])).toHaveLength(1);
  });

  test("blocks a changed expected value when the code under test did not change", () => {
    const after = BASE.replace(`expect(login(null)).toBe(400);`, `expect(login(null)).toBe(401);`);
    const vs = run(testWeakened, [{ path: T, before: BASE, after }], {
      files: { "src/auth.ts": SRC_BEFORE },
    });
    expect(vs).toHaveLength(1);
    expect(vs[0]?.severity).toBe("block");
    expect(vs[0]?.detail).toContain("400");
    expect(vs[0]?.detail).toContain("401");
    expect(vs[0]?.line).toBe(8);
  });

  test("flags a deleted test file", () => {
    const vs = run(testWeakened, [{ path: T, before: BASE, after: null }], {
      files: { "src/auth.ts": SRC_BEFORE },
    });
    expect(vs).toHaveLength(1);
    expect(vs[0]?.detail).toContain("2 tests");
  });

  test("flags a new .only test in an existing file", () => {
    const after = BASE.replace(
      /\n}\);\n$/,
      `\n  it.only("new", () => { expect(1).toBe(1); });\n});\n`,
    );
    const vs = run(testWeakened, [{ path: T, before: BASE, after }]);
    expect(vs.map((v) => v.detail)).toEqual([expect.stringContaining("only")]);
  });

  test("compares a renamed test file against its old path", () => {
    const after = BASE.replace(`    expect(logout()).toBe(true);\n`, "");
    const vs = run(testWeakened, [
      { path: "test/session.test.ts", oldPath: T, before: BASE, after },
    ]);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.file).toBe("test/session.test.ts");
  });
});

describe("test-weakened: negatives", () => {
  test("a renamed test with the same assertions is fine", () => {
    const after = BASE.replace(`it("logs out"`, `it("logs the user out"`);
    expect(run(testWeakened, [{ path: T, before: BASE, after }])).toEqual([]);
  });

  test("adding assertions is fine", () => {
    const after = BASE.replace(
      `    expect(logout()).toBe(true);\n`,
      `    expect(logout()).toBe(true);\n    expect(logout()).not.toBe(false);\n`,
    );
    expect(run(testWeakened, [{ path: T, before: BASE, after }])).toEqual([]);
  });

  test("adding a new test is fine", () => {
    const after = BASE.replace(/\n}\);\n$/, `\n  it("new", () => { expect(1).toBe(1); });\n});\n`);
    expect(run(testWeakened, [{ path: T, before: BASE, after }])).toEqual([]);
  });

  test("reformatting is fine", () => {
    const after = BASE.replace(
      `expect(login("bad")).toBe(401);`,
      `expect(login( "bad" )).toBe( 401 );`,
    );
    expect(run(testWeakened, [{ path: T, before: BASE, after }])).toEqual([]);
  });

  test("removing a test whose subject was removed from the source is fine", () => {
    const after = BASE.replace(/\n {2}it\("logs out"[\s\S]*?\n {2}}\);\n/, "\n").replace(
      "login, logout",
      "login",
    );
    const vs = run(testWeakened, [
      { path: T, before: BASE, after },
      {
        path: "src/auth.ts",
        before: SRC_BEFORE,
        after: "export function login(t: string | null) { return 401; }\n",
      },
    ]);
    expect(vs).toEqual([]);
  });

  test("deleting a test file together with the module it tests is fine", () => {
    const vs = run(testWeakened, [
      { path: T, before: BASE, after: null },
      { path: "src/auth.ts", before: SRC_BEFORE, after: null },
    ]);
    expect(vs).toEqual([]);
  });

  test("a changed expected value is only a warning when the code under test changed too", () => {
    const after = BASE.replace(`expect(login(null)).toBe(400);`, `expect(login(null)).toBe(422);`);
    const vs = run(testWeakened, [
      { path: T, before: BASE, after },
      {
        path: "src/auth.ts",
        before: SRC_BEFORE,
        after: SRC_BEFORE.replace("return 401;", "return t === null ? 422 : 401;"),
      },
    ]);
    expect(kinds(vs)).toEqual([["warn", expect.any(String)]]);
  });

  test("non-test files are ignored", () => {
    const after = BASE.replace(`    expect(logout()).toBe(true);\n`, "");
    expect(run(testWeakened, [{ path: "src/checks.ts", before: BASE, after }])).toEqual([]);
  });

  test("moving a test within the file is fine", () => {
    const logsOut = `  it("logs out", () => {\n    expect(logout()).toBe(true);\n  });\n`;
    const after = BASE.replace(`\n${logsOut}`, "\n").replace(
      `describe("auth", () => {\n`,
      `describe("auth", () => {\n${logsOut}\n`,
    );
    expect(run(testWeakened, [{ path: T, before: BASE, after }])).toEqual([]);
  });

  test("a new test file with skipped tests is fine", () => {
    expect(
      run(testWeakened, [{ path: "test/new.test.ts", after: `it.skip("wip", () => {});\n` }]),
    ).toEqual([]);
  });

  test("removing .only is fine", () => {
    const before = BASE.replace(`it("logs out"`, `it.only("logs out"`);
    expect(run(testWeakened, [{ path: T, before, after: BASE }])).toEqual([]);
  });

  test("renaming a test file without changes is fine", () => {
    expect(
      run(testWeakened, [{ path: "test/x.test.ts", oldPath: T, before: BASE, after: BASE }]),
    ).toEqual([]);
  });

  test("reordering assertions is fine", () => {
    const after = BASE.replace(
      `    expect(login("bad")).toBe(401);\n    expect(login("")).toBe(401);\n`,
      `    expect(login("")).toBe(401);\n    expect(login("bad")).toBe(401);\n`,
    );
    expect(run(testWeakened, [{ path: T, before: BASE, after }])).toEqual([]);
  });

  test("a test file that no longer parses is skipped (parse-error handles it)", () => {
    expect(
      run(testWeakened, [{ path: T, before: BASE, after: `${BASE}\nit("broken", () => {` }]),
    ).toEqual([]);
  });
});
