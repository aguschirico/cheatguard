import { blobIdAt, blobSizes, diffTrees, readBlobsBySha } from "./git/index.js";

export const MAX_ANALYZED_BYTES = 1024 * 1024;
/** Above this edit distance the exact diff is replaced by a linear multiset approximation. */
const MAX_EDIT_DISTANCE = 1000;

export type SkipReason = "binary" | "too-large";

export interface FileChange {
  /** POSIX path relative to the repository root (the "after" path for renames). */
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  before: string | null;
  after: string | null;
  /** 1-based line numbers in `after` that are new or modified. */
  addedLines: ReadonlySet<number>;
  skipReason: SkipReason | null;
}

export interface CollectOptions {
  maxBytes?: number;
}

export interface TextRead {
  text: string | null;
  skip: SkipReason | null;
}

function isBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, 8000);
  for (let i = 0; i < end; i += 1) if (buf[i] === 0) return true;
  return false;
}

/** Source files are always decoded: a stray NUL must not make them unanalyzable. */
const CODE_PATH_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc)$/i;

function decode(buf: Buffer | undefined, path: string): TextRead {
  if (!buf) return { text: null, skip: null };
  if (!CODE_PATH_RE.test(path) && isBinary(buf)) return { text: null, skip: "binary" };
  return { text: buf.toString("utf8"), skip: null };
}

export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Lines of `after` (1-based) that are new or modified relative to `before`.
 * Exact (Myers O(ND)) up to an edit distance of MAX_EDIT_DISTANCE, linear multiset approximation beyond.
 */
export function computeAddedLines(before: string | null, after: string): Set<number> {
  const b = before === null ? [] : splitLines(before);
  const a = splitLines(after);
  let start = 0;
  while (start < b.length && start < a.length && b[start] === a[start]) start += 1;
  let endB = b.length;
  let endA = a.length;
  while (endB > start && endA > start && b[endB - 1] === a[endA - 1]) {
    endB -= 1;
    endA -= 1;
  }
  const added = new Set<number>();
  const x = b.slice(start, endB);
  const y = a.slice(start, endA);
  if (y.length === 0) return added;
  const insertions =
    x.length === 0 ? y.map((_, i) => i) : (myersInsertions(x, y) ?? multisetInsertions(x, y));
  for (const yi of insertions) added.add(start + yi + 1);
  return added;
}

function multisetInsertions(x: readonly string[], y: readonly string[]): number[] {
  const counts = new Map<string, number>();
  for (const line of x) counts.set(line, (counts.get(line) ?? 0) + 1);
  const insertions: number[] = [];
  y.forEach((line, i) => {
    const count = counts.get(line) ?? 0;
    if (count > 0) counts.set(line, count - 1);
    else insertions.push(i);
  });
  return insertions;
}

/** Indices in `y` inserted relative to `x`, or null when the edit distance exceeds the bound. */
function myersInsertions(x: readonly string[], y: readonly string[]): number[] | null {
  const n = x.length;
  const m = y.length;
  const maxD = Math.min(n + m, MAX_EDIT_DISTANCE);
  // v[k + maxD] = furthest x on diagonal k. trace[d] keeps a copy of v for diagonals -d..d.
  const v = new Int32Array(2 * maxD + 3);
  const trace: Int32Array[] = [];
  const at = (arr: Int32Array, k: number): number => arr[k + maxD + 1] ?? 0;
  let done = false;
  for (let d = 0; d <= maxD; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && at(v, k - 1) < at(v, k + 1));
      let px = down ? at(v, k + 1) : at(v, k - 1) + 1;
      let py = px - k;
      while (px < n && py < m && x[px] === y[py]) {
        px += 1;
        py += 1;
      }
      v[k + maxD + 1] = px;
      if (px >= n && py >= m) {
        done = true;
        break;
      }
    }
    trace.push(v.slice());
    if (done) break;
  }
  if (!done) return null;
  const insertions: number[] = [];
  let px = n;
  let py = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const prev = trace[d - 1];
    if (!prev) break;
    const k = px - py;
    const down = k === -d || (k !== d && at(prev, k - 1) < at(prev, k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prev, prevK);
    const prevY = prevX - prevK;
    while (px > prevX && py > prevY) {
      px -= 1;
      py -= 1;
    }
    if (down) insertions.push(prevY);
    px = prevX;
    py = prevY;
  }
  return insertions.sort((p, q) => p - q);
}

/** Reads one file version from a tree with the same size/binary policy as collectChanges. */
export function readTextAt(
  root: string,
  tree: string,
  path: string,
  maxBytes = MAX_ANALYZED_BYTES,
): TextRead {
  const id = blobIdAt(root, tree, path);
  if (!id) return { text: null, skip: null };
  const size = blobSizes(root, [id]).get(id) ?? 0;
  if (size > maxBytes) return { text: null, skip: "too-large" };
  return decode(readBlobsBySha(root, [id]).get(id), path);
}

export function collectChanges(
  root: string,
  baseTree: string,
  headTree: string,
  options: CollectOptions = {},
): FileChange[] {
  const maxBytes = options.maxBytes ?? MAX_ANALYZED_BYTES;
  const raw = diffTrees(root, baseTree, headTree);
  const ids = raw.flatMap((c) => [c.oldBlob, c.newBlob]).filter((id): id is string => id !== null);
  const sizes = blobSizes(root, ids);
  const loadable = ids.filter((id) => (sizes.get(id) ?? 0) <= maxBytes);
  const blobs = readBlobsBySha(root, loadable);
  const read = (id: string | null, path: string): TextRead => {
    if (id === null) return { text: null, skip: null };
    if ((sizes.get(id) ?? 0) > maxBytes) return { text: null, skip: "too-large" };
    return decode(blobs.get(id), path);
  };
  return raw.map((change) => {
    const before = read(change.oldBlob, change.oldPath ?? change.path);
    const after = read(change.newBlob, change.path);
    const skipReason = after.skip ?? before.skip;
    const result: FileChange = {
      path: change.path,
      status: change.status,
      before: skipReason ? null : before.text,
      after: skipReason ? null : after.text,
      addedLines:
        skipReason || after.text === null ? new Set() : computeAddedLines(before.text, after.text),
      skipReason,
    };
    if (change.oldPath !== undefined) result.oldPath = change.oldPath;
    return result;
  });
}
