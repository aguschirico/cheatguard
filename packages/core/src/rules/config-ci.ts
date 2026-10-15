/**
 * Line-based checks for CI workflow files (GitHub Actions, GitLab CI). YAML is not parsed: the
 * checks look for the few constructs that turn a failing check green.
 */
import { parse as parseYaml } from "yaml";
import { splitLines } from "../changes.js";

function parses(text: string): boolean {
  try {
    parseYaml(text);
    return true;
  } catch {
    return false;
  }
}

export interface CiFinding {
  line: number;
  detail: string;
  fix: string;
}

const CHECK_RE =
  /\b(test|tests|lint|typecheck|type-check|tsc|vitest|jest|mocha|playwright|eslint|biome|coverage|check)\b/;
const COMMAND_RE = /(^|\s)(run:|npm |pnpm |yarn |npx |bun |node |make )/;
const SWALLOW_RE = /\|\|\s*(true|exit\s+0|:)(\s|$)|;\s*(true|exit\s+0)(\s|$)/;
const TRUE = String.raw`(true|yes|on|1|"true"|'true'|\$\{\{\s*true\s*\}\})`;
const FALSE = String.raw`(false|no|off|0|"false"|'false'|"0"|'0'|\$\{\{\s*(false|0)\s*\}\})`;
const CONTINUE_RE = new RegExp(
  String.raw`^\s*(-\s*)?(continue-on-error|allow_failure):\s*${TRUE}\s*$`,
);
const DISABLED_RE = new RegExp(String.raw`^\s*(-\s*)?(if:\s*${FALSE}|when:\s*["']?never["']?)\s*$`);
/** Shell lines that make a script ignore failing commands. */
const IGNORE_ERRORS_RE = /^\s*(-\s*)?(run:\s*)?set\s+\+e\b/;

const norm = (line: string): string => line.trim().replace(/\s+/g, " ");

function counts(lines: readonly string[], re: RegExp): number {
  return lines.filter((l) => re.test(l)).length;
}

/** The check words a command line runs ("npm run lint" → "lint"). */
function checkWords(line: string): string[] {
  return [...line.matchAll(new RegExp(CHECK_RE.source, "g"))].map((m) => m[1] ?? "");
}

export function ciFindings(before: string, after: string): CiFinding[] {
  const was = splitLines(before);
  const now = splitLines(after);
  const findings: CiFinding[] = [];
  const firstLine = (re: RegExp): number => now.findIndex((l) => re.test(l)) + 1;
  if (parses(before) && !parses(after)) {
    findings.push({
      line: 1,
      detail: "The CI file is no longer valid YAML, so the CI service may skip or reject it",
      fix: "Fix the YAML syntax; a broken workflow runs no checks.",
    });
  }

  if (counts(now, CONTINUE_RE) > counts(was, CONTINUE_RE)) {
    findings.push({
      line: firstLine(CONTINUE_RE),
      detail: "A CI step or job was allowed to fail (continue-on-error / allow_failure)",
      fix: "Remove it and fix the failing check.",
    });
  }
  if (counts(now, DISABLED_RE) > counts(was, DISABLED_RE)) {
    findings.push({
      line: firstLine(DISABLED_RE),
      detail: "A CI step or job was disabled with a constant false condition",
      fix: "Remove the condition and fix the failing check.",
    });
  }
  if (counts(now, IGNORE_ERRORS_RE) > counts(was, IGNORE_ERRORS_RE)) {
    findings.push({
      line: firstLine(IGNORE_ERRORS_RE),
      detail: "A CI script now ignores failing commands (set +e)",
      fix: "Remove `set +e` and fix the failing check.",
    });
  }
  const oldSet = new Set(was.map(norm));
  now.forEach((line, i) => {
    if (oldSet.has(norm(line))) return;
    if (COMMAND_RE.test(line) && CHECK_RE.test(line) && SWALLOW_RE.test(line)) {
      findings.push({
        line: i + 1,
        detail: `A CI check can no longer fail: ${norm(line)}`,
        fix: "Remove the `|| true` (or equivalent) and fix the failing check.",
      });
    }
  });
  const newSet = new Set(now.map(norm));
  const remaining = now.filter((l) => COMMAND_RE.test(l)).flatMap(checkWords);
  for (const line of was) {
    if (newSet.has(norm(line)) || !COMMAND_RE.test(line) || !CHECK_RE.test(line)) continue;
    const words = checkWords(line);
    if (words.some((w) => !remaining.includes(w))) {
      findings.push({
        line: 0,
        detail: `A CI check was removed: ${norm(line)}`,
        fix: "Restore the step; CI must keep running every check it ran before.",
      });
    }
  }
  return findings;
}
