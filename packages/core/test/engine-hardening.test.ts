import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { check } from "../src/engine.js";
import { createTempRepo } from "./helpers/repo.js";

const TEST = `import { expect, it } from "vitest";\nit("a", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n`;

describe("engine hardening", () => {
  test("a test file padded past the analysis limit is blocked, not silently skipped", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.test.ts": TEST });
    repo.write(
      "src/a.test.ts",
      `${TEST.replace("  expect(2).toBe(2);\n", "")}// ${"x".repeat(1024 * 1024 + 100)}\n`,
    );
    const result = check({
      root: repo.root,
      base: "HEAD",
      head: "worktree",
      config: DEFAULT_CONFIG,
    });
    expect(result.violations.map((v) => [v.rule, v.severity])).toEqual([["parse-error", "block"]]);
    expect(result.violations[0]?.detail).toContain("too large");
  });

  test("a NUL byte does not make a source file unanalyzable", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": "export const a = 1;\n" });
    repo.write("src/a.ts", "// \u0000\nexport const a: any = 1;\n");
    const result = check({
      root: repo.root,
      base: "HEAD",
      head: "worktree",
      config: DEFAULT_CONFIG,
    });
    expect(result.violations.map((v) => v.rule)).toEqual(["type-suppression"]);
  });

  test("declaration files are analyzed", () => {
    const repo = createTempRepo({ "package.json": "{}" });
    repo.write(
      "src/shims.d.ts",
      `declare module "legacy" {\n  const value: any;\n  export default value;\n}\n`,
    );
    const result = check({
      root: repo.root,
      base: "HEAD",
      head: "worktree",
      config: DEFAULT_CONFIG,
    });
    expect(result.violations.map((v) => v.rule)).toEqual(["type-suppression"]);
  });

  test("real binary assets are still skipped quietly", () => {
    const repo = createTempRepo({ "package.json": "{}" });
    repo.write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    const result = check({
      root: repo.root,
      base: "HEAD",
      head: "worktree",
      config: DEFAULT_CONFIG,
    });
    expect(result.violations).toEqual([]);
    expect(result.skipped).toEqual([{ path: "logo.png", reason: "binary" }]);
  });
});
