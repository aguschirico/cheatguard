import { describe, expect, test } from "vitest";
import { computeAddedLines, type FileChange } from "../src/changes.js";
import { parseConfig } from "../src/config/index.js";
import { filterIgnored } from "../src/engine.js";
import { selectNew } from "../src/lint/index.js";
import type { Diagnostic } from "../src/lint/types.js";

// Behaviors an adversarial mutation run showed no test would notice if they broke.
const change = (path: string, before: string | null, after: string): FileChange => ({
  path,
  status: before === null ? "added" : "modified",
  before,
  after,
  addedLines: computeAddedLines(before, after),
  skipReason: null,
});

const diag = (file: string, line: number): Diagnostic => ({
  tool: "tsc",
  file,
  line,
  column: 1,
  code: "TS2322",
  message: "x",
  severity: "error",
});

describe("config files are never ignorable", () => {
  test.each([
    ["cheatguard.config.json"],
    ["tsconfig.json"],
    ["package.json"],
    ["vitest.config.ts"],
    [".claude/settings.json"],
    [".github/workflows/ci.yml"],
  ])("%s survives an ignore pattern that matches it", (path) => {
    const config = parseConfig({ ignore: ["**/*", "**"] });
    const kept = filterIgnored(
      [change(path, "a\n", "b\n"), change("src/a.ts", "a\n", "b\n")],
      config,
    );
    expect(kept.map((c) => c.path)).toEqual([path]);
  });
});

describe("lint attribution without a baseline", () => {
  test("every diagnostic in a new file is new", () => {
    const changes = [change("src/new.ts", null, "a\nb\nc\n")];
    const selection = selectNew([diag("src/new.ts", 3)], changes, null, () => "");
    expect(selection.fresh).toHaveLength(1);
  });

  test("diagnostics on unchanged lines of a modified file are pre-existing", () => {
    const changes = [change("src/a.ts", "a\nb\n", "a\nb\nc\n")];
    const selection = selectNew(
      [diag("src/a.ts", 1), diag("src/a.ts", 3)],
      changes,
      null,
      () => "",
    );
    expect(selection.fresh.map((d) => d.line)).toEqual([3]);
    expect(selection.preexisting).toBe(1);
  });

  test("diagnostics in files outside the change are counted, not shown", () => {
    const selection = selectNew([diag("src/other.ts", 1)], [], null, () => "");
    expect(selection.fresh).toEqual([]);
    expect(selection.outsideChange).toBe(1);
  });

  test("with a baseline, files edited while it was recorded fall back to changed lines", () => {
    const changes = [change("src/a.ts", "a\nb\n", "a\nb\nc\n")];
    const known = ["fp"];
    const readLine = (): string => "same";
    // The fingerprint of line 3 is in the baseline, but src/a.ts was dirty: line attribution wins.
    const withDirty = selectNew([diag("src/a.ts", 3)], changes, known, readLine, ["src/a.ts"]);
    expect(withDirty.fresh).toHaveLength(1);
  });
});
