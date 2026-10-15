import { describe, expect, test } from "vitest";
import { collectChanges, computeAddedLines } from "../src/changes.js";
import { resolveTree, snapshotWorkingTree } from "../src/git/index.js";
import { createTempRepo } from "./helpers/repo.js";

describe("hardening", () => {
  test.skipIf(process.platform === "win32")(
    "a file name containing a newline cannot desynchronize blob contents",
    () => {
      const repo = createTempRepo({ "a.ts": "a-before\n", "z.ts": "z-before\n" });
      repo.write("a.ts", "a-after\n");
      repo.write("evil\nname.ts", "evil\n");
      repo.write("z.ts", "z-after\n");
      const changes = collectChanges(
        repo.root,
        resolveTree(repo.root, "HEAD"),
        snapshotWorkingTree(repo.root),
      );
      const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
      expect(byPath["a.ts"]?.before).toBe("a-before\n");
      expect(byPath["a.ts"]?.after).toBe("a-after\n");
      expect(byPath["evil\nname.ts"]?.after).toBe("evil\n");
      expect(byPath["z.ts"]?.before).toBe("z-before\n");
      expect(byPath["z.ts"]?.after).toBe("z-after\n");
    },
  );

  test("blobs over the size cap are never loaded (reported as too-large)", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    repo.write("big.ts", "y".repeat(5000));
    const changes = collectChanges(
      repo.root,
      resolveTree(repo.root, "HEAD"),
      snapshotWorkingTree(repo.root),
      { maxBytes: 1000 },
    );
    expect(changes[0]?.skipReason).toBe("too-large");
  });

  test("completely different large files diff in bounded time and memory", () => {
    const before = Array.from({ length: 30_000 }, (_, i) => `before ${i}`).join("\n");
    const after = Array.from({ length: 30_000 }, (_, i) => `after ${i}`).join("\n");
    const start = performance.now();
    const added = computeAddedLines(before, after);
    expect(added.size).toBe(30_000);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test("fallback keeps unchanged lines unmarked when the edit distance is huge", () => {
    const shared = Array.from({ length: 5000 }, (_, i) => `shared ${i}`);
    const before = [...shared, ...Array.from({ length: 20_000 }, (_, i) => `old ${i}`)].join("\n");
    const after = [...Array.from({ length: 20_000 }, (_, i) => `new ${i}`), ...shared].join("\n");
    const added = computeAddedLines(before, after);
    expect(added.size).toBe(20_000);
    expect(added.has(20_001)).toBe(false);
  });
});

describe("racy git", () => {
  test("a same-size edit in the same second as the index write is still detected", async () => {
    const { statSync, utimesSync } = await import("node:fs");
    const { join } = await import("node:path");
    const repo = createTempRepo({ "a.ts": "const a = 1;\n" });
    const indexTime = statSync(join(repo.root, ".git", "index")).mtime;
    repo.write("a.ts", "const a = 2;\n");
    // Same size and the same timestamp as the index: only git's racy-entry check can see the edit.
    utimesSync(join(repo.root, "a.ts"), indexTime, indexTime);
    // The snapshot happens later (a loaded machine, a slow agent turn).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const changes = collectChanges(
      repo.root,
      resolveTree(repo.root, "HEAD"),
      snapshotWorkingTree(repo.root),
    );
    expect(changes.map((c) => [c.path, c.status])).toEqual([["a.ts", "modified"]]);
  });
});
