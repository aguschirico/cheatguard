import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { toRepoPath } from "../src/lint/paths.js";

test("tool paths that go through a symlinked root still map to repo paths", () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), "cg-real-")));
  mkdirSync(join(real, "src"));
  writeFileSync(join(real, "src", "a.ts"), "");
  const link = join(mkdtempSync(join(tmpdir(), "cg-link-")), "repo");
  symlinkSync(real, link, "junction");
  expect(toRepoPath(link, join(real, "src", "a.ts"))).toBe("src/a.ts");
  expect(toRepoPath(real, join(link, "src", "a.ts"))).toBe("src/a.ts");
  expect(toRepoPath(link, "src/a.ts")).toBe("src/a.ts");
});
