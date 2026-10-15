import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, git, gitBuffer, NotAGitRepoError } from "./exec.js";

export { GitError, NotAGitRepoError } from "./exec.js";

/** Directory where cheatguard keeps session state; never part of snapshots. */
export const STATE_DIR = ".cheatguard";

export function repoRoot(cwd: string): string {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch (error) {
    if (error instanceof GitError) throw new NotAGitRepoError(cwd);
    throw error;
  }
}

function emptyTree(root: string): string {
  return git(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" }).trim();
}

/** Resolves a ref (commit, tag, branch, tree) to a tree id. An unborn HEAD resolves to the empty tree. */
export function resolveTree(root: string, ref: string): string {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`]).trim();
  } catch (error) {
    if (ref === "HEAD" && error instanceof GitError) return emptyTree(root);
    throw new GitError(`Unknown git ref "${ref}"`);
  }
}

/** The commit HEAD points to, or "" on an unborn branch. */
export function headCommit(root: string): string {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).trim();
  } catch {
    return "";
  }
}

/** Tree of the current index (what `git commit` would record). Does not modify the index. */
export function indexTree(root: string): string {
  return git(root, ["write-tree"]).trim();
}

/** True when sparse checkout is on: then skip-worktree entries missing from disk are expected. */
function sparseCheckout(root: string): boolean {
  try {
    return git(root, ["config", "--bool", "core.sparseCheckout"]).trim() === "true";
  } catch {
    return false;
  }
}

/** Index entries flagged skip-worktree whose file is absent from disk. */
function skippedAndMissing(root: string): string[] {
  return git(root, ["ls-files", "-t", "-z"])
    .split("\0")
    .filter((e) => e.startsWith("S "))
    .map((e) => e.slice(2))
    .filter((path) => !existsSync(join(root, path)));
}

/**
 * Paths a sparse checkout leaves out of the working tree. Record them when a session starts and
 * pass them to snapshotWorkingTree: the agent can turn sparse checkout on and flag files itself.
 */
export function sparseEntries(root: string): string[] {
  return sparseCheckout(root) ? skippedAndMissing(root) : [];
}

export interface SnapshotOptions {
  /** Paths allowed to be absent without counting as deleted. Default: the current sparse entries. */
  sparse?: ReadonlySet<string>;
}

/** The exact commands `git lfs install` configures; anything else is treated as a custom filter. */
const LFS_FILTERS: Record<string, string> = {
  clean: "git-lfs clean -- %f",
  process: "git-lfs filter-process",
  smudge: "git-lfs smudge -- %f",
};

/**
 * `-c` overrides that turn every configured clean filter into a pass-through, so a filter cannot
 * rewrite what the snapshot records. Only an untouched Git LFS setup keeps its filter (the base
 * holds LFS pointers, so the snapshot must too).
 */
function neutralFilters(root: string): string[] {
  let out = "";
  try {
    out = git(root, ["config", "-z", "--get-regexp", "^filter\\..*\\.(clean|process)$"]);
  } catch {
    return []; // no filters configured
  }
  const overrides: string[] = [];
  const seen = new Set<string>();
  for (const entry of out.split("\0").filter(Boolean)) {
    const [key = "", value = ""] = entry.split("\n");
    const match = /^filter\.(.+)\.(clean|process)$/.exec(key);
    const name = match?.[1];
    const kind = match?.[2];
    if (!name || !kind || seen.has(name)) continue;
    if (name === "lfs" && LFS_FILTERS[kind] === value.trim()) continue;
    seen.add(name);
    // required=false: if the emptied process filter errors, git stores the raw content.
    overrides.push(
      "-c",
      `filter.${name}.clean=cat`,
      "-c",
      `filter.${name}.process=`,
      "-c",
      `filter.${name}.required=false`,
    );
  }
  return overrides;
}

/** Settings that let git skip reading files: fsmonitor answers, cached untracked dirs, sparse patterns. */
const NO_SHORTCUTS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.sparseCheckout=false",
];

/**
 * Records the whole working tree (tracked + untracked, honoring .gitignore) as a tree object,
 * using a throwaway index so the user's index and files are never touched.
 *
 * The throwaway index starts from the real index's entries without their stat data, so git hashes
 * every file instead of trusting cached timestamps (an edit that restores size and mtime is still
 * seen), and without assume-unchanged / skip-worktree flags. Only `options.sparse` paths that are
 * absent from disk keep skip-worktree.
 */
export function snapshotWorkingTree(root: string, options: SnapshotOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cheatguard-index-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  try {
    const allowed = options.sparse ?? new Set(sparseEntries(root));
    const entries = git(root, ["ls-files", "-s", "-z"]).split("\0").filter(Boolean);
    const stageZero = entries.filter((e) => /^\d+ [0-9a-f]+ 0\t/.test(e));
    git(root, ["read-tree", "--empty"], { env });
    if (stageZero.length > 0) {
      git(root, ["update-index", "-z", "--index-info"], {
        env,
        input: `${stageZero.join("\0")}\0`,
      });
    }
    const keep =
      allowed.size === 0 ? [] : skippedAndMissing(root).filter((path) => allowed.has(path));
    if (keep.length > 0) {
      git(root, ["update-index", "--skip-worktree", "-z", "--stdin"], {
        env,
        input: `${keep.join("\0")}\0`,
      });
    }
    git(root, [...NO_SHORTCUTS, ...neutralFilters(root), "add", "-A"], { env });
    git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", STATE_DIR], { env });
    return git(root, ["write-tree"], { env }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Writes the files of `tree` into `dir` (outside the repository) without touching the user's index
 * or working tree. Filters are neutralized so no configured command runs.
 */
export function checkoutTree(root: string, tree: string, dir: string): void {
  const indexDir = mkdtempSync(join(tmpdir(), "cheatguard-index-"));
  const env = { GIT_INDEX_FILE: join(indexDir, "index") };
  try {
    git(root, ["read-tree", tree], { env });
    const filters = neutralFilters(root).map((arg) => arg.replace(/\.clean=cat$/, ".smudge=cat"));
    git(
      root,
      [...filters, "checkout-index", "-a", "-f", `--prefix=${dir.endsWith("/") ? dir : `${dir}/`}`],
      {
        env,
      },
    );
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

/** Ignored directories named node_modules (installed dependencies), relative to the root. */
export function dependencyDirs(root: string): string[] {
  return git(root, ["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"])
    .split("\0")
    .map((entry) => entry.replace(/\/$/, ""))
    .filter((entry) => entry === "node_modules" || entry.endsWith("/node_modules"));
}

/** Paths (old and new) that differ between two trees. */
export function changedPaths(root: string, base: string, head: string): string[] {
  const paths = new Set<string>();
  for (const change of diffTrees(root, base, head)) {
    paths.add(change.path);
    if (change.oldPath) paths.add(change.oldPath);
  }
  return [...paths];
}

export type RawStatus = "added" | "modified" | "deleted" | "renamed";

export interface RawChange {
  status: RawStatus;
  path: string;
  oldPath?: string;
  /** Blob id on the base side (null for additions). */
  oldBlob: string | null;
  /** Blob id on the head side (null for deletions). */
  newBlob: string | null;
}

const NULL_SHA = /^0+$/;

/** Parses `git diff-tree -r -M -z --raw`. Paths travel NUL-separated, blobs by id, so no name can desync parsing. */
export function diffTrees(root: string, base: string, head: string): RawChange[] {
  const out = git(root, ["diff-tree", "-r", "-M", "-z", "--raw", "--no-commit-id", base, head]);
  const parts = out.split("\0");
  const changes: RawChange[] = [];
  let i = 0;
  while (i < parts.length) {
    const meta = parts[i];
    if (!meta?.startsWith(":")) {
      i += 1;
      continue;
    }
    const [, , oldSha = "", newSha = "", code = ""] = meta.slice(1).split(" ");
    const oldBlob = NULL_SHA.test(oldSha) ? null : oldSha;
    const newBlob = NULL_SHA.test(newSha) ? null : newSha;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = parts[i + 1];
      const path = parts[i + 2];
      if (oldPath !== undefined && path !== undefined) {
        changes.push(
          letter === "R"
            ? { status: "renamed", path, oldPath, oldBlob, newBlob }
            : { status: "added", path, oldBlob: null, newBlob },
        );
      }
      i += 3;
      continue;
    }
    const path = parts[i + 1];
    if (path !== undefined) {
      const status: RawStatus = letter === "A" ? "added" : letter === "D" ? "deleted" : "modified";
      changes.push({ status, path, oldBlob, newBlob });
    }
    i += 2;
  }
  return changes;
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function assertShas(shas: readonly string[]): void {
  for (const sha of shas) if (!SHA_RE.test(sha)) throw new GitError(`Invalid object id: ${sha}`);
}

/** Sizes of blobs by id, without loading their content. */
export function blobSizes(root: string, shas: readonly string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  const unique = [...new Set(shas)];
  if (unique.length === 0) return sizes;
  assertShas(unique);
  const out = git(root, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], {
    input: `${unique.join("\n")}\n`,
  });
  for (const line of out.split("\n")) {
    const [sha, size] = line.split(" ");
    if (sha && size && SHA_RE.test(sha)) sizes.set(sha, Number(size));
  }
  return sizes;
}

/** Loads blob contents by id with one git process. Callers must cap sizes first. */
export function readBlobsBySha(root: string, shas: readonly string[]): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const unique = [...new Set(shas)];
  if (unique.length === 0) return result;
  assertShas(unique);
  const out = gitBuffer(root, ["cat-file", "--batch"], { input: `${unique.join("\n")}\n` });
  let offset = 0;
  for (const sha of unique) {
    const newline = out.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = out.subarray(offset, newline).toString("utf8");
    offset = newline + 1;
    if (header.endsWith(" missing")) continue;
    const size = Number(header.split(" ")[2]);
    result.set(sha, out.subarray(offset, offset + size));
    offset += size + 1;
  }
  return result;
}

/** Resolves `<tree>:<path>` to a blob id (path passed via argv, never stdin). */
export function blobIdAt(root: string, tree: string, path: string): string | null {
  try {
    const id = git(root, ["rev-parse", "--verify", "--quiet", `${tree}:${path}`]).trim();
    return SHA_RE.test(id) ? id : null;
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}
