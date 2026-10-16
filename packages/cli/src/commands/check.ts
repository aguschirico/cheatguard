import { parseArgs } from "node:util";
import {
  check,
  formatJson,
  formatPretty,
  type LintResult,
  planTools,
  type Report,
  runLint,
  summarize,
  type ToolProblem,
} from "@cheatguard/core";
import { openRepo, useColor } from "../context.js";
import { EXIT, UsageError } from "../errors.js";
import { cliToolProblems, readBaselineFile } from "./lint.js";

export const CHECK_HELP = `cheatguard check [paths...] [options]

Checks the changes in your working tree (or index) against a base ref.

Options:
  --base <ref>        Compare against this git ref (default: HEAD)
  --staged            Check only staged changes (the index)
  --format <fmt>      pretty (default) or json
  --no-lint           Skip running eslint/biome/oxlint/tsc on the changed files
  --lint-baseline <f> Lint baseline file from "cheatguard lint --snapshot" (report only new diagnostics)

Exit codes: 0 clean · 1 blocking issues · 3 tool error (including a linter that could not run)`;

export function runCheck(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: "string", default: "HEAD" },
      staged: { type: "boolean", default: false },
      format: { type: "string", default: "pretty" },
      "no-lint": { type: "boolean", default: false },
      "lint-baseline": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${CHECK_HELP}\n`);
    return EXIT.ok;
  }
  if (values.format !== "pretty" && values.format !== "json")
    throw new UsageError(`Unknown format "${values.format}" (use pretty or json)`);
  const { root, baseTree, config } = openRepo(process.cwd(), values.base);
  const result = check({
    root,
    base: { tree: baseTree },
    head: values.staged ? "index" : "worktree",
    config,
    paths: positionals,
  });
  let lint: LintResult | undefined;
  let toolProblems: ToolProblem[] = [];
  if (!values["no-lint"]) {
    const plan = planTools(root, config);
    if (plan.tools.length > 0) {
      const baseline = values["lint-baseline"] ? readBaselineFile(values["lint-baseline"]) : null;
      lint = runLint({
        root,
        tools: plan.tools,
        changes: result.changes,
        baseline: baseline?.fingerprints ?? null,
      });
    }
    toolProblems = cliToolProblems(plan, lint?.tools ?? []);
  }
  const report: Report = {
    check: result,
    maxDiagnostics: config.lint.maxDiagnostics,
    toolProblems,
  };
  if (lint) report.lint = lint;
  process.stdout.write(
    `${values.format === "json" ? formatJson(report) : formatPretty(report, { color: useColor(process.stdout) })}\n`,
  );
  const summary = summarize(report);
  const lintErrors = lint?.newDiagnostics.filter((d) => d.severity === "error").length ?? 0;
  if (summary.block > 0 || (config.lint.blockOnStop && lintErrors > 0)) return EXIT.violations;
  return summary.toolFailures > 0 ? EXIT.toolError : EXIT.ok;
}
