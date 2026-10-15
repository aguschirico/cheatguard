import { chmodSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { collectChanges } from "../src/changes.js";
import { resolveTree, snapshotWorkingTree, sparseEntries } from "../src/git/index.js";
import { createTempRepo } from "./helpers/repo.js";

// Repros from the adversarial review: git features that hid working-tree edits from snapshots.
const changedPaths = (root: string): string[] =>
  collectChanges(root, resolveTree(root, "HEAD"), snapshotWorkingTree(root)).map((c) => c.path);

describe("snapshots see edits git is told to ignore", () => {
  test("assume-unchanged does not hide an edit", () => {
    const repo = createTempRepo({ "src/a.test.ts": "expect(1).toBe(1);\n" });
    repo.git("update-index", "--assume-unchanged", "src/a.test.ts");
    repo.write("src/a.test.ts", "// gone\n");
    expect(changedPaths(repo.root)).toEqual(["src/a.test.ts"]);
    // The user's own index keeps the flag.
    expect(repo.git("ls-files", "-v", "src/a.test.ts")).toMatch(/^h /);
  });

  test("skip-worktree does not hide an edit", () => {
    const repo = createTempRepo({ "src/a.test.ts": "expect(1).toBe(1);\n" });
    repo.git("update-index", "--skip-worktree", "src/a.test.ts");
    repo.write("src/a.test.ts", "// gone\n");
    expect(changedPaths(repo.root)).toEqual(["src/a.test.ts"]);
  });

  test("sparse-checkout entries missing from disk are not reported as deleted", () => {
    const repo = createTempRepo({ "src/a.ts": "a\n", "docs/b.md": "b\n" });
    repo.git("config", "core.sparseCheckout", "true");
    repo.git("update-index", "--skip-worktree", "docs/b.md");
    repo.remove("docs/b.md");
    expect(changedPaths(repo.root)).toEqual([]);
  });

  test("a clean filter cannot rewrite what the snapshot records", () => {
    const repo = createTempRepo({ "src/a.test.ts": "expect(1).toBe(1);\n" });
    repo.git("config", "filter.keep.clean", "git show HEAD:%f");
    writeFileSync(join(repo.root, ".git", "info", "attributes"), "src/a.test.ts filter=keep\n");
    repo.write("src/a.test.ts", "// gone\n");
    expect(changedPaths(repo.root)).toEqual(["src/a.test.ts"]);
  });
});

describe("snapshots do not trust git's stat cache or helpers", () => {
  test("an edit that keeps size and mtime is still seen", () => {
    const repo = createTempRepo({ "src/b.ts": "b\n" });
    // Make git's own stat check ignore ctime, so git really is fooled (the precondition below).
    repo.git("config", "core.trustctime", "false");
    repo.git("config", "core.checkStat", "minimal");
    const file = join(repo.root, "src/a.test.ts");
    const old = new Date("2001-01-01T00:00:00Z");
    // An old mtime keeps the entry out of git's racy window, so git trusts its stat cache.
    writeFileSync(file, "expect(sum(2, 2)).toBe(4);\n");
    utimesSync(file, old, old);
    repo.commit("add test");
    writeFileSync(file, "expect(sum(2, 2)).toBe(5);\n");
    utimesSync(file, old, old);
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(changedPaths(repo.root)).toEqual(["src/a.test.ts"]);
  });

  test("assume-unchanged on a deleted file does not hide the deletion", () => {
    const repo = createTempRepo({ "src/a.test.ts": "x\n", "src/b.ts": "y\n" });
    repo.git("update-index", "--assume-unchanged", "src/a.test.ts");
    repo.remove("src/a.test.ts");
    expect(changedPaths(repo.root)).toEqual(["src/a.test.ts"]);
  });

  test("skip-worktree plus deleting the file is a deletion when sparse checkout is off", () => {
    const repo = createTempRepo({ "src/a.test.ts": "x\n", "src/b.ts": "y\n" });
    repo.git("update-index", "--skip-worktree", "src/a.test.ts");
    repo.remove("src/a.test.ts");
    expect(changedPaths(repo.root)).toEqual(["src/a.test.ts"]);
  });

  test("a filter that only pretends to be git-lfs is neutralized", () => {
    const repo = createTempRepo({ "src/a.test.ts": "expect(1).toBe(1);\n" });
    repo.git("config", "filter.lfs.clean", "git-lfs clean -- %f || git show HEAD:%f");
    writeFileSync(join(repo.root, ".git", "info", "attributes"), "src/a.test.ts filter=lfs\n");
    repo.write("src/a.test.ts", "// gone\n");
    expect(changedPaths(repo.root)).toEqual(["src/a.test.ts"]);
  });

  test("an fsmonitor hook cannot hide edits", () => {
    const repo = createTempRepo({ "src/a.test.ts": "expect(1).toBe(1);\n" });
    repo.write(".git/hooks/fake-fsmonitor", "#!/bin/sh\nprintf '\\0'\n");
    chmodSync(join(repo.root, ".git/hooks/fake-fsmonitor"), 0o755);
    repo.git("config", "core.fsmonitor", ".git/hooks/fake-fsmonitor");
    repo.write("src/a.test.ts", "// gone\n");
    expect(changedPaths(repo.root)).toEqual(["src/a.test.ts"]);
  });
});

describe("sparse checkout cannot be turned into a hiding place", () => {
  test("files outside a sparse pattern but present on disk are still read", () => {
    const repo = createTempRepo({ "src/a.test.ts": "a\n", "docs/b.md": "b\n" });
    repo.git("sparse-checkout", "set", "--no-cone", "/docs/");
    repo.write("src/a.test.ts", "evil\n");
    expect(changedPaths(repo.root)).toEqual(["src/a.test.ts"]);
  });

  test("sparse entries recorded at session start stay trusted; new ones do not", () => {
    const repo = createTempRepo({ "src/a.test.ts": "a\n", "docs/b.md": "b\n" });
    repo.git("config", "core.sparseCheckout", "true");
    repo.git("update-index", "--skip-worktree", "docs/b.md");
    repo.remove("docs/b.md");
    const atStart = new Set(sparseEntries(repo.root));
    expect([...atStart]).toEqual(["docs/b.md"]);
    // The agent flags and deletes a test later.
    repo.git("update-index", "--skip-worktree", "src/a.test.ts");
    repo.remove("src/a.test.ts");
    const tree = snapshotWorkingTree(repo.root, { sparse: atStart });
    const changes = collectChanges(repo.root, resolveTree(repo.root, "HEAD"), tree);
    expect(changes.map((c) => [c.path, c.status])).toEqual([["src/a.test.ts", "deleted"]]);
  });
});
