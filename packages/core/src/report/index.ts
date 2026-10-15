import type { CheckResult } from "../engine.js";
import type { Diagnostic, LintResult } from "../lint/types.js";
import type { LintToolName, Violation } from "../types.js";

/** A linter that should have run but could not (missing, crashed, broken config). */
export interface ToolProblem {
  tool: LintToolName;
  error: string;
  /** True when the problem must stop the run (a required tool, or one that worked before). */
  blocking: boolean;
}

export interface Report {
  check: CheckResult;
  lint?: LintResult;
  /** Max lint diagnostics to print (the JSON report always has them all). */
  maxDiagnostics?: number;
  toolProblems?: ToolProblem[];
}

const DEFAULT_MAX_DIAGNOSTICS = 20;

export interface Summary {
  block: number;
  warn: number;
  lintNew: number;
  /** Linters that could not run and must be fixed (see ToolProblem.blocking). */
  toolFailures: number;
}

export function summarize(report: Report): Summary {
  const block = report.check.violations.filter((v) => v.severity === "block").length;
  return {
    block,
    warn: report.check.violations.length - block,
    lintNew: report.lint?.newDiagnostics.length ?? 0,
    toolFailures: report.toolProblems?.filter((p) => p.blocking).length ?? 0,
  };
}

export function formatJson(report: Report): string {
  const summary = summarize(report);
  const lintErrors = report.lint?.newDiagnostics.filter((d) => d.severity === "error").length ?? 0;
  return JSON.stringify(
    {
      version: 1,
      ok: summary.block === 0 && lintErrors === 0 && summary.toolFailures === 0,
      summary: {
        ...summary,
        filesAnalyzed: report.check.filesAnalyzed,
        skipped: report.check.skipped.length,
      },
      violations: report.check.violations,
      ...(report.lint
        ? {
            lint: {
              newDiagnostics: report.lint.newDiagnostics,
              preexisting: report.lint.preexisting,
              tools: report.lint.tools,
            },
          }
        : {}),
      ...(report.toolProblems?.length ? { toolProblems: report.toolProblems } : {}),
    },
    null,
    2,
  );
}

const ANSI = {
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  reset: "\u001b[0m",
};

function paint(color: boolean, code: keyof typeof ANSI, text: string): string {
  return color ? `${ANSI[code]}${text}${ANSI.reset}` : text;
}

function location(file: string, line: number): string {
  return line > 0 ? `${file}:${line}` : file;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

function lintLines(lint: LintResult, max: number, bullet: (d: Diagnostic) => string): string[] {
  const lines = lint.newDiagnostics
    .slice(0, max)
    .map(
      (d) =>
        `${bullet(d)} ${d.tool}${d.code ? `/${d.code}` : ""} ${location(d.file, d.line)} — ${d.message}`,
    );
  const hidden = lint.newDiagnostics.length - max;
  if (hidden > 0) lines.push(`  …and ${hidden} more new diagnostics`);
  if (lint.outsideChange > 0) {
    lines.push(
      `  (${lint.outsideChange} diagnostics in files you did not change; record a baseline to tell new from old)`,
    );
  }
  return lines;
}

export function formatPretty(report: Report, options: { color: boolean }): string {
  const { color } = options;
  const out: string[] = [];
  const summary = summarize(report);
  for (const [file, violations] of groupBy(report.check.violations, (v) => v.file)) {
    out.push(paint(color, "bold", file));
    for (const v of violations) {
      const mark = v.severity === "block" ? paint(color, "red", "✗") : paint(color, "yellow", "!");
      out.push(
        `  ${mark} ${v.line > 0 ? `${v.line}`.padStart(4) : "    "}  ${v.detail} ${paint(color, "dim", `[${v.rule}]`)}`,
      );
      out.push(`         ${paint(color, "dim", `→ ${v.fix}`)}`);
    }
    out.push("");
  }
  const lint = report.lint;
  if (lint && (lint.newDiagnostics.length > 0 || lint.outsideChange > 0)) {
    out.push(paint(color, "bold", "New lint/type diagnostics"));
    out.push(
      ...lintLines(
        lint,
        report.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS,
        (d) =>
          `  ${d.severity === "error" ? paint(color, "red", "✗") : paint(color, "yellow", "!")}`,
      ),
    );
    out.push("");
  }
  for (const problem of report.toolProblems ?? []) {
    out.push(
      problem.blocking
        ? paint(color, "red", `✗ ${problem.tool} could not run: ${problem.error}`)
        : paint(color, "yellow", `! ${problem.tool} could not run: ${problem.error}`),
    );
  }
  if ((report.toolProblems ?? []).length > 0) out.push("");
  const clean = summary.block === 0 && summary.warn === 0 && summary.lintNew === 0;
  if (clean && summary.toolFailures > 0) {
    out.push(
      paint(
        color,
        "red",
        `✗ ${summary.toolFailures} linter${summary.toolFailures === 1 ? "" : "s"} could not run, so the change was not fully checked.`,
      ),
    );
  } else if (clean) {
    out.push(
      paint(color, "green", `✓ No issues in ${report.check.filesAnalyzed} changed file(s).`),
    );
  } else {
    const parts = [
      `${summary.block} blocking`,
      `${summary.warn} warning${summary.warn === 1 ? "" : "s"}`,
    ];
    if (lint)
      parts.push(
        `${summary.lintNew} new lint/type diagnostic${summary.lintNew === 1 ? "" : "s"} (${lint.preexisting} pre-existing hidden)`,
      );
    out.push(
      `${summary.block > 0 ? paint(color, "red", "✗") : paint(color, "yellow", "!")} ${parts.join(", ")} in ${report.check.filesAnalyzed} changed file(s).`,
    );
  }
  return out.join("\n");
}

function hookViolation(v: Violation): string {
  const mark = v.severity === "block" ? "✗" : "!";
  return `${mark} [${v.rule}] ${location(v.file, v.line)} — ${v.detail}\n  → ${v.fix}`;
}

export interface HookFormatOptions {
  /** Whether this output stops the agent; sets the heading. */
  blocking?: boolean;
  /** Overrides the heading (e.g. warnings shown once at Stop). */
  heading?: string;
}

/** Compact text meant to be read by a coding agent. */
export function formatHook(report: Report, options: HookFormatOptions = {}): string {
  const summary = summarize(report);
  const blocking = options.blocking ?? summary.block > 0;
  const out: string[] = [];
  if (options.heading) {
    out.push(options.heading);
  } else if (blocking && summary.block > 0) {
    out.push(
      `cheatguard: ${summary.block} blocking issue${summary.block === 1 ? "" : "s"} in your changes. Fix them properly (do not work around the check):`,
    );
  } else if (blocking) {
    out.push(
      "cheatguard: your changes are not finished. Fix these before stopping (do not work around the check):",
    );
  } else if (summary.warn > 0 || summary.lintNew > 0 || (report.toolProblems ?? []).length > 0) {
    out.push("cheatguard: review these before finishing:");
  }
  for (const problem of report.toolProblems ?? []) {
    out.push(
      `${problem.blocking ? "✗" : "!"} [lint] ${problem.tool} could not run: ${problem.error}\n  → ${
        problem.blocking
          ? `Restore ${problem.tool} (reinstall it or fix its config) so the change can be checked; do not remove or break linters.`
          : `Run ${problem.tool} yourself if you can; cheatguard could not check this part of the change.`
      }`,
    );
  }
  out.push(...report.check.violations.map(hookViolation));
  if (report.lint && report.lint.newDiagnostics.length === 0 && report.lint.outsideChange > 0) {
    out.push(
      `(${report.lint.outsideChange} lint/type diagnostics in files you did not change could not be attributed: no baseline was recorded. Run the type checker if your change can affect other files.)`,
    );
  }
  if (report.lint && report.lint.newDiagnostics.length > 0) {
    out.push(
      `New lint/type diagnostics introduced by your changes (${report.lint.preexisting} pre-existing hidden):`,
    );
    out.push(
      ...lintLines(report.lint, report.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS, (d) =>
        d.severity === "error" ? "✗" : "!",
      ),
    );
  }
  return out.join("\n");
}

export type { Violation } from "../types.js";
