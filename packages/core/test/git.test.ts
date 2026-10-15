import { realpathSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { collectChanges, computeAddedLines, readTextAt } from "../src/changes.js";
import {
  indexTree,
  NotAGitRepoError,
  repoRoot,
  resolveTree,
  snapshotWorkingTree,
} from "../src/git/index.js";
import { createTempRepo, tempNonRepoDir } from "./helpers/repo.js";

describe("repoRoot", () => {
  test("finds the root from a subdirectory", () => {
    const repo = createTempRepo({ "src/a.ts": "export const a = 1;\n" });
    // Compare resolved paths: on Windows git prints C:/Users/... while the temp dir may be an 8.3 name.
    const same = (p: string): string => realpathSync.native(p);
    expect(same(repoRoot(`${repo.root}/src`))).toBe(same(repo.root));
  });

  test("throws NotAGitRepoError outside a repository", () => {
    expect(() => repoRoot(tempNonRepoDir())).toThrow(NotAGitRepoError);
  });
});

describe("snapshots and changes", () => {
  test("detects modified, added, deleted and untracked files against HEAD", () => {
    const repo = createTempRepo({
      "a.ts": "const a = 1;\n",
      "b.ts": "const b = 1;\n",
    });
    repo.write("a.ts", "const a = 2;\n");
    repo.remove("b.ts");
    repo.write("c.ts", "const c = 1;\n");
    const changes = collectChanges(
      repo.root,
      resolveTree(repo.root, "HEAD"),
      snapshotWorkingTree(repo.root),
    );
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    expect(byPath["a.ts"]?.status).toBe("modified");
    expect(byPath["a.ts"]?.before).toBe("const a = 1;\n");
    expect(byPath["a.ts"]?.after).toBe("const a = 2;\n");
    expect(byPath["b.ts"]?.status).toBe("deleted");
    expect(byPath["b.ts"]?.after).toBeNull();
    expect(byPath["c.ts"]?.status).toBe("added");
    expect(byPath["c.ts"]?.before).toBeNull();
  });

  test("detects renames and keeps the old path", () => {
    const body = Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    const repo = createTempRepo({ "old.test.ts": `${body}\n` });
    repo.remove("old.test.ts");
    repo.write("new.test.ts", `${body}\nexport const extra = 1;\n`);
    const changes = collectChanges(
      repo.root,
      resolveTree(repo.root, "HEAD"),
      snapshotWorkingTree(repo.root),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.status).toBe("renamed");
    expect(changes[0]?.oldPath).toBe("old.test.ts");
    expect(changes[0]?.path).toBe("new.test.ts");
    expect([...(changes[0]?.addedLines ?? [])]).toEqual([21]);
  });

  test("respects .gitignore and never snapshots .cheatguard state", () => {
    const repo = createTempRepo({ ".gitignore": "ignored/\n", "a.ts": "1\n" });
    repo.write("ignored/x.ts", "x\n");
    repo.write(".cheatguard/sessions/s.json", "{}\n");
    const changes = collectChanges(
      repo.root,
      resolveTree(repo.root, "HEAD"),
      snapshotWorkingTree(repo.root),
    );
    expect(changes).toEqual([]);
  });

  test("works when .cheatguard is itself gitignored", () => {
    const repo = createTempRepo({ ".gitignore": ".cheatguard/\n", "a.ts": "1\n" });
    repo.write(".cheatguard/sessions/s.json", "{}\n");
    repo.write("a.ts", "2\n");
    const changes = collectChanges(
      repo.root,
      resolveTree(repo.root, "HEAD"),
      snapshotWorkingTree(repo.root),
    );
    expect(changes.map((c) => c.path)).toEqual(["a.ts"]);
  });

  test("does not modify the user's real index", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    repo.write("a.ts", "2\n");
    repo.write("staged.ts", "s\n");
    repo.git("add", "staged.ts");
    const before = repo.git("diff", "--cached", "--name-status");
    snapshotWorkingTree(repo.root);
    expect(repo.git("diff", "--cached", "--name-status")).toBe(before);
    expect(repo.git("status", "--porcelain")).toContain(" M a.ts");
  });

  test("a working-tree baseline hides changes that existed before the session", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    repo.write("a.ts", "dirty before session\n");
    repo.write("untracked-before.ts", "u\n");
    const baseline = snapshotWorkingTree(repo.root);
    repo.write("b.ts", "new in session\n");
    const changes = collectChanges(repo.root, baseline, snapshotWorkingTree(repo.root));
    expect(changes.map((c) => c.path)).toEqual(["b.ts"]);
  });

  test("works in a repository without commits", () => {
    const repo = createTempRepo();
    repo.write("a.ts", "1\n");
    const changes = collectChanges(
      repo.root,
      resolveTree(repo.root, "HEAD"),
      snapshotWorkingTree(repo.root),
    );
    expect(changes.map((c) => [c.path, c.status])).toEqual([["a.ts", "added"]]);
  });

  test("indexTree reflects only staged content", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    repo.write("a.ts", "2\n");
    repo.write("b.ts", "b\n");
    repo.git("add", "b.ts");
    const changes = collectChanges(repo.root, resolveTree(repo.root, "HEAD"), indexTree(repo.root));
    expect(changes.map((c) => c.path)).toEqual(["b.ts"]);
  });

  test("marks binary files and does not decode them", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    repo.write("img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const [change] = collectChanges(
      repo.root,
      resolveTree(repo.root, "HEAD"),
      snapshotWorkingTree(repo.root),
    );
    expect(change?.skipReason).toBe("binary");
    expect(change?.after).toBeNull();
  });

  test("marks files over 1 MB as too large", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    repo.write("big.js", `${"x".repeat(1024 * 1024 + 10)}\n`);
    const [change] = collectChanges(
      repo.root,
      resolveTree(repo.root, "HEAD"),
      snapshotWorkingTree(repo.root),
    );
    expect(change?.skipReason).toBe("too-large");
    expect(change?.after).toBeNull();
  });

  test("readTextAt returns content or null", () => {
    const repo = createTempRepo({ "dir/a.ts": "hello\n" });
    const tree = resolveTree(repo.root, "HEAD");
    expect(readTextAt(repo.root, tree, "dir/a.ts").text).toBe("hello\n");
    expect(readTextAt(repo.root, tree, "missing.ts").text).toBeNull();
    expect(readTextAt(repo.root, tree, "dir/a.ts", 2).skip).toBe("too-large");
  });

  test("handles paths with spaces and unicode", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    repo.write("my dir/ñandú test.ts", "x\n");
    const changes = collectChanges(
      repo.root,
      resolveTree(repo.root, "HEAD"),
      snapshotWorkingTree(repo.root),
    );
    expect(changes.map((c) => c.path)).toEqual(["my dir/ñandú test.ts"]);
  });
});

describe("computeAddedLines", () => {
  test("returns 1-based line numbers of inserted lines", () => {
    expect([...computeAddedLines("a\nb\nc\n", "a\nX\nb\nc\nY\n")]).toEqual([2, 5]);
  });

  test("treats modified lines as added", () => {
    expect([...computeAddedLines("a\nb\nc\n", "a\nB\nc\n")]).toEqual([2]);
  });

  test("all lines are added for a new file", () => {
    expect([...computeAddedLines(null, "a\nb\n")]).toEqual([1, 2]);
  });

  test("CRLF and LF versions of the same text produce no added lines", () => {
    expect([...computeAddedLines("a\r\nb\r\n", "a\nb\n")]).toEqual([]);
  });

  test("CRLF edits report the same lines as LF edits", () => {
    expect([...computeAddedLines("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n")]).toEqual([2]);
  });

  test("handles large files with few edits quickly", () => {
    const before = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n");
    const lines = before.split("\n");
    lines.splice(10_000, 0, "inserted");
    const start = performance.now();
    expect([...computeAddedLines(before, lines.join("\n"))]).toEqual([10_001]);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
