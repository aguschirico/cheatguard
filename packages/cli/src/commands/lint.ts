import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  changedPaths,
  check,
  formatJson,
  formatPretty,
  type LintBaseline,
  loadSession,
  planTools,
  runLint,
  saveLintBaseline,
  snapshotLintBaseline,
  snapshotLintBaselineAt,
  snapshotWorkingTree,
  type ToolPlan,
  type ToolProblem,
} from "@cheatguard/core";
import { openRepo, useColor } from "../context.js";
import { EXIT, UsageError } from "../errors.js";

export const LINT_HELP = `cheatguard lint [options]

Runs your existing linters (eslint, biome, tsc) on what changed and prints only NEW diagnostics,
compactly. Pre-existing problems are hidden.

Options:
  --base <ref>          Compare against this git ref (default: HEAD)
  --staged              Use staged changes only
  --baseline <file>     Baseline from --snapshot; anything not in it is new
  --snapshot <file>     Record every current diagnostic to <file> and exit
  --format <fmt>        pretty (default) or json`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export function readBaselineFile(path: string): LintBaseline {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.fingerprints))
      throw new Error("missing fingerprints");
    return {
      tools: stringList(parsed.tools).filter(
        (t): t is LintBaseline["tools"][number] => t === "eslint" || t === "biome" || t === "tsc",
      ),
      fingerprints: stringList(parsed.fingerprints),
      errors: [],
      dirtyFiles: [],
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch (error) {
    throw new UsageError(
      `Cannot read lint baseline ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * CLI runs fail closed: a tool that crashed, or a tool listed in lint.tools that cannot run, is an
 * error. With lint.tools "auto", a configured but uninstalled tool is only a warning.
 */
export function cliToolProblems(
  plan: ToolPlan,
  runs: readonly { tool: ToolProblem["tool"]; ok: boolean; error?: string }[],
): ToolProblem[] {
  return [
    ...plan.missing.map((m) => ({ tool: m.tool, error: m.reason, blocking: m.required })),
    ...runs
      .filter((r) => !r.ok)
      .map((r) => ({ tool: r.tool, error: r.error ?? "unknown error", blocking: true })),
  ];
}

export function runLintCommand(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string", default: "HEAD" },
      staged: { type: "boolean", default: false },
      baseline: { type: "string" },
      snapshot: { type: "string" },
      "snapshot-session": { type: "string" },
      format: { type: "string", default: "pretty" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${LINT_HELP}\n`);
    return EXIT.ok;
  }
  const { root, baseTree, config } = openRepo(process.cwd(), values.base);
  const sessionId = values["snapshot-session"];
  if (sessionId) {
    // Internal: background baseline for a Claude Code session (spawned by the SessionStart hook).
    const session = loadSession(root, sessionId);
    if (!session) return EXIT.ok;
    let baseline = snapshotLintBaseline(root, session.tools);
    // If the agent edited files while the linters ran, the baseline may contain its errors (also in
    // files it did not touch): record it again from the session's starting tree.
    const now = snapshotWorkingTree(root, { sparse: new Set(session.sparse) });
    const dirty = changedPaths(root, session.baselineTree, now);
    if (dirty.length > 0) {
      const atStart = snapshotLintBaselineAt(root, session.baselineTree, session.tools);
      // A checkout without generated files can make a tool fail; then keep the working-tree
      // baseline and attribute the edited files by changed lines.
      if (atStart.errors.length <= baseline.errors.length) baseline = atStart;
      else baseline.dirtyFiles = dirty;
    }
    saveLintBaseline(root, session.id, baseline);
    return EXIT.ok;
  }
  const plan = planTools(root, config);
  const tools = plan.tools;
  if (values.snapshot) {
    const baseline = snapshotLintBaseline(root, tools);
    writeFileSync(values.snapshot, JSON.stringify(baseline));
    process.stdout.write(
      `Recorded ${baseline.fingerprints.length} diagnostics from ${tools.join(", ") || "no tools"} to ${values.snapshot}\n`,
    );
    for (const error of baseline.errors) process.stderr.write(`warning: ${error}\n`);
    return EXIT.ok;
  }
  if (tools.length === 0 && plan.missing.length === 0) {
    process.stdout.write(
      "No configured linters found (eslint, biome or tsc with a config and a local install).\n",
    );
    return EXIT.ok;
  }
  const result = check({
    root,
    base: { tree: baseTree },
    head: values.staged ? "index" : "worktree",
    config,
    scopes: [],
  });
  const baseline = values.baseline ? readBaselineFile(values.baseline) : null;
  const lint = runLint({
    root,
    tools,
    changes: result.changes,
    baseline: baseline?.fingerprints ?? null,
  });
  const toolProblems = cliToolProblems(plan, lint.tools);
  const report = {
    check: { ...result, violations: [] },
    lint,
    maxDiagnostics: config.lint.maxDiagnostics,
    toolProblems,
  };
  process.stdout.write(
    `${values.format === "json" ? formatJson(report) : formatPretty(report, { color: useColor(process.stdout) })}\n`,
  );
  const errors = lint.newDiagnostics.filter((d) => d.severity === "error").length;
  if (errors > 0) return EXIT.violations;
  return toolProblems.some((p) => p.blocking) ? EXIT.toolError : EXIT.ok;
}
