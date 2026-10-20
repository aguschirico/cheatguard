import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FileChange } from "../changes.js";
import { splitLines } from "../changes.js";
import { checkoutTree, dependencyDirs } from "../git/index.js";
import type { LintToolName } from "../types.js";
import { fingerprintAll } from "./fingerprint.js";
import { DEFAULT_TIMEOUT_MS, runTool } from "./run.js";
import type { Diagnostic, LintResult, ToolRun } from "./types.js";

export { detectTools, type MissingTool, planTools, type ToolPlan } from "./detect.js";
export type { Diagnostic, LintResult, ToolRun } from "./types.js";

const LINTABLE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const TS_RELEVANT_RE =
  /(\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$)|(^|\/)(tsconfig[\w.-]*\.json|package\.json)$/i;

function lineReader(root: string): (file: string, line: number) => string {
  const cache = new Map<string, string[]>();
  return (file, line) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, splitLines(readFileSync(join(root, file), "utf8")));
      } catch {
        cache.set(file, []);
      }
    }
    return cache.get(file)?.[line - 1] ?? "";
  };
}

export interface Selection {
  fresh: Diagnostic[];
  preexisting: number;
  outsideChange: number;
}

/**
 * Splits diagnostics into those introduced by the change and those that were already there.
 * With a baseline, a diagnostic is new when its fingerprint was not recorded, except in
 * `dirtyFiles` (edited while the baseline was being recorded, so the baseline may already contain
 * the agent's errors): those, like everything without a baseline, are attributed by changed lines.
 */
export function selectNew(
  diagnostics: readonly Diagnostic[],
  changes: readonly FileChange[],
  baseline: readonly string[] | null,
  readLine: (file: string, line: number) => string,
  dirtyFiles: readonly string[] = [],
): Selection {
  const byPath = new Map(changes.map((c) => [c.path, c]));
  const dirty = new Set(dirtyFiles);
  const known = baseline ? new Set(baseline) : null;
  const fps = known ? fingerprintAll(diagnostics, readLine) : [];
  const fresh: Diagnostic[] = [];
  let preexisting = 0;
  let outsideChange = 0;
  diagnostics.forEach((d, i) => {
    if (known && !dirty.has(d.file)) {
      if (known.has(fps[i] ?? "")) preexisting += 1;
      else fresh.push(d);
      return;
    }
    const change = byPath.get(d.file);
    if (!change) {
      outsideChange += 1;
      return;
    }
    if (change.status === "added" || change.addedLines.has(d.line)) fresh.push(d);
    else preexisting += 1;
  });
  return { fresh, preexisting, outsideChange };
}

export interface RunLintOptions {
  root: string;
  tools: readonly LintToolName[];
  changes: readonly FileChange[];
  /** Fingerprints recorded before the change (session start); null → attribute by changed lines. */
  baseline: readonly string[] | null;
  /** Files edited while the baseline was recorded: attributed by changed lines. */
  dirtyFiles?: readonly string[];
  timeoutMs?: number;
}

const SEVERITY_RANK = { error: 0, warning: 1 } as const;

/** Runs the linters (all at once) on the changed files and keeps what the change introduced. */
export async function runLint(options: RunLintOptions): Promise<LintResult> {
  const start = performance.now();
  const files = options.changes
    .filter((c) => c.after !== null && LINTABLE_RE.test(c.path))
    .map((c) => c.path);
  const tsRelevant = options.changes.some((c) => TS_RELEVANT_RE.test(c.path));
  const selected = options.tools.filter((tool) => (tool === "tsc" ? tsRelevant : files.length > 0));
  const outputs = await Promise.all(
    selected.map((tool) =>
      runTool(
        options.root,
        tool,
        tool === "tsc" ? "all" : files,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ),
    ),
  );
  const tools: ToolRun[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const [index, tool] of selected.entries()) {
    const output = outputs[index];
    if (!output) continue;
    const run: ToolRun = {
      tool,
      ok: output.error === undefined,
      durationMs: output.durationMs,
      rawChars: output.rawChars,
      total: output.diagnostics.length,
    };
    if (output.error !== undefined) run.error = output.error;
    tools.push(run);
    diagnostics.push(...output.diagnostics);
  }
  const selection = selectNew(
    diagnostics,
    options.changes,
    options.baseline,
    lineReader(options.root),
    options.dirtyFiles,
  );
  selection.fresh.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  return {
    tools,
    newDiagnostics: selection.fresh,
    preexisting: selection.preexisting,
    outsideChange: selection.outsideChange,
    rawChars: tools.reduce((n, t) => n + t.rawChars, 0),
    durationMs: performance.now() - start,
  };
}

export interface LintBaseline {
  tools: LintToolName[];
  fingerprints: string[];
  /** "<tool>: <message>" for each tool that could not run when the baseline was recorded. */
  errors: string[];
  /** Files that changed while the baseline was being recorded (see selectNew). */
  dirtyFiles: string[];
  createdAt: string;
}

/** Records every current diagnostic of every tool, so later runs can report only new ones. */
export async function snapshotLintBaseline(
  root: string,
  tools: readonly LintToolName[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LintBaseline> {
  const diagnostics: Diagnostic[] = [];
  const errors: string[] = [];
  const outputs = await Promise.all(tools.map((tool) => runTool(root, tool, "all", timeoutMs)));
  for (const [index, tool] of tools.entries()) {
    const output = outputs[index];
    if (!output) continue;
    if (output.error) errors.push(`${tool}: ${output.error}`);
    diagnostics.push(...output.diagnostics);
  }
  return {
    tools: [...tools],
    fingerprints: fingerprintAll(diagnostics, lineReader(root)),
    errors,
    dirtyFiles: [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Records the baseline of a git tree rather than of the working tree: the tree is checked out to a
 * temporary directory (with the project's installed dependencies linked in) and linted there. Used
 * when the agent edited files while the working-tree baseline was being recorded.
 */
export async function snapshotLintBaselineAt(
  root: string,
  tree: string,
  tools: readonly LintToolName[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LintBaseline> {
  const dir = mkdtempSync(join(tmpdir(), "cheatguard-baseline-"));
  try {
    checkoutTree(root, tree, dir);
    for (const deps of dependencyDirs(root)) {
      mkdirSync(dirname(join(dir, deps)), { recursive: true });
      symlinkSync(join(root, deps), join(dir, deps), "junction");
    }
    return await snapshotLintBaseline(dir, tools, timeoutMs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
