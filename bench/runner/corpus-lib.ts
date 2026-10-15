import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeAddedLines,
  createProjectContext,
  DEFAULT_CONFIG,
  type FileChange,
  memorySource,
  RULE_IDS,
  type RuleId,
  runRules,
  type Violation,
} from "@cheatguard/core";
import { z } from "zod";

export const CORPUS_SETS = ["synthetic", "agent", "human"] as const;
export type CorpusSet = (typeof CORPUS_SETS)[number];

export function isCorpusSet(value: unknown): value is CorpusSet {
  return CORPUS_SETS.some((s) => s === value);
}

/** Parses a --set option, failing with a clear message instead of casting. */
export function corpusSetOption(value: string | undefined): CorpusSet {
  if (isCorpusSet(value)) return value;
  throw new Error(`Unknown corpus set "${value ?? ""}" (use ${CORPUS_SETS.join(", ")})`);
}

const ruleId = z.enum(RULE_IDS);
const caseSchema = z.object({
  id: z.string(),
  set: z.enum(CORPUS_SETS),
  description: z.string(),
  source: z
    .object({
      url: z.string(),
      repo: z.string(),
      license: z.string(),
      author: z.string().optional(),
      mergedAt: z.string().optional(),
    })
    .optional(),
  changes: z.array(
    z.object({
      path: z.string(),
      oldPath: z.string().optional(),
      before: z.string().nullable(),
      after: z.string().nullable(),
    }),
  ),
  context: z.record(z.string(), z.string()),
  expected: z.array(z.object({ rule: ruleId, file: z.string() })),
  notes: z.string().optional(),
});

/** Reads and validates one case file. */
export function readCase(path: string): CorpusCase {
  return caseSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export interface CaseChange {
  path: string;
  oldPath?: string | undefined;
  before: string | null;
  after: string | null;
}

export interface ExpectedFlag {
  rule: RuleId;
  file: string;
}

export interface CorpusCase {
  id: string;
  set: CorpusSet;
  description: string;
  source?:
    | {
        url: string;
        repo: string;
        license: string;
        author?: string | undefined;
        mergedAt?: string | undefined;
      }
    | undefined;
  changes: CaseChange[];
  /** Unchanged project files needed for context (package.json, tsconfig, modules). */
  context: Record<string, string>;
  /** Ground truth: (rule, file) pairs a correct tool must report. */
  expected: ExpectedFlag[];
  notes?: string | undefined;
}

export function caseDir(root: string, set: CorpusSet): string {
  return join(root, set);
}

export function writeCase(root: string, c: CorpusCase): void {
  const dir = join(root, c.set);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${c.id}.json`), `${JSON.stringify(c, null, 2)}\n`);
}

export function loadCases(root: string, set: CorpusSet): CorpusCase[] {
  let files: string[];
  try {
    files = readdirSync(join(root, set))
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  return files.map((f) => readCase(join(root, set, f)));
}

export function toFileChanges(c: CorpusCase): FileChange[] {
  return c.changes.map((ch) => {
    const status =
      ch.before === null
        ? "added"
        : ch.after === null
          ? "deleted"
          : ch.oldPath
            ? "renamed"
            : "modified";
    const change: FileChange = {
      path: ch.path,
      status,
      before: ch.before,
      after: ch.after,
      addedLines: ch.after === null ? new Set() : computeAddedLines(ch.before, ch.after),
      skipReason: null,
    };
    if (ch.oldPath) change.oldPath = ch.oldPath;
    return change;
  });
}

export function changedLines(c: CorpusCase): number {
  let total = 0;
  for (const ch of c.changes) {
    const added = ch.after === null ? 0 : computeAddedLines(ch.before, ch.after).size;
    const removed = ch.before === null ? 0 : computeAddedLines(ch.after, ch.before).size;
    total += added + removed;
  }
  return total;
}

export interface CaseResult {
  id: string;
  set: CorpusSet;
  predicted: Violation[];
  durationMs: number;
}

export function runCase(c: CorpusCase): CaseResult {
  const files: Record<string, string> = { ...c.context };
  for (const ch of c.changes) if (ch.after !== null) files[ch.path] = ch.after;
  const project = createProjectContext("/corpus", memorySource(files));
  const start = performance.now();
  const result = runRules({ changes: toFileChanges(c), project, config: DEFAULT_CONFIG });
  return {
    id: c.id,
    set: c.set,
    predicted: result.violations.filter((v) => v.rule !== "parse-error"),
    durationMs: performance.now() - start,
  };
}

export interface RuleScore {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

const pairKey = (rule: string, file: string): string => `${rule}\u0000${file}`;

export interface Scored {
  perRule: Record<string, RuleScore>;
  overall: RuleScore;
  errors: Array<{ id: string; kind: "fp" | "fn"; rule: string; file: string; detail?: string }>;
}

function finish(s: { tp: number; fp: number; fn: number }): RuleScore {
  const precision = s.tp + s.fp === 0 ? null : s.tp / (s.tp + s.fp);
  const recall = s.tp + s.fn === 0 ? null : s.tp / (s.tp + s.fn);
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  return { ...s, precision, recall, f1 };
}

/** Scores by (rule, file) pairs: several violations of one rule in one file count once. */
export function score(cases: readonly CorpusCase[], results: readonly CaseResult[]): Scored {
  const counts: Record<string, { tp: number; fp: number; fn: number }> = {};
  for (const id of RULE_IDS) if (id !== "parse-error") counts[id] = { tp: 0, fp: 0, fn: 0 };
  const errors: Scored["errors"] = [];
  const byId = new Map(results.map((r) => [r.id, r]));
  for (const c of cases) {
    const result = byId.get(c.id);
    if (!result) continue;
    const expected = new Set(c.expected.map((e) => pairKey(e.rule, e.file)));
    const predicted = new Map<string, Violation>();
    for (const v of result.predicted)
      if (!predicted.has(pairKey(v.rule, v.file))) predicted.set(pairKey(v.rule, v.file), v);
    for (const [key, v] of predicted) {
      const bucket = counts[v.rule];
      if (!bucket) continue;
      if (expected.has(key)) bucket.tp += 1;
      else {
        bucket.fp += 1;
        errors.push({ id: c.id, kind: "fp", rule: v.rule, file: v.file, detail: v.detail });
      }
    }
    for (const e of c.expected) {
      if (predicted.has(pairKey(e.rule, e.file))) continue;
      const bucket = counts[e.rule];
      if (bucket) bucket.fn += 1;
      errors.push({ id: c.id, kind: "fn", rule: e.rule, file: e.file });
    }
  }
  const perRule: Record<string, RuleScore> = {};
  const total = { tp: 0, fp: 0, fn: 0 };
  for (const [rule, s] of Object.entries(counts)) {
    perRule[rule] = finish(s);
    total.tp += s.tp;
    total.fp += s.fp;
    total.fn += s.fn;
  }
  return { perRule, overall: finish(total), errors };
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}
