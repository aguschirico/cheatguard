/**
 * Verdicts on edits to quality-gate scripts (package.json "test", "lint", "typecheck"...).
 * A script is blocked when the edit can make it pass without running what it ran before.
 */

const NEUTRALIZER_RE =
  /\|\|\s*(true|exit\s+0|:)(\s|$)|;\s*exit\s+0|^\s*(echo|true|exit\s+0|:)(\s|$)|--pass-?with-?no-?tests|--passWithNoTests|--max-warnings[= ]?\d{3,}/i;

/** Shell operators that change which exit status the script reports. */
const OPERATORS: ReadonlyArray<[string, RegExp]> = [
  ["||", /\|\|/g],
  [";", /;/g],
  ["&", /(?<!&)&(?!&)/g],
  ["|", /(?<!\|)\|(?!\|)/g],
  ["exit", /\bexit\b/g],
];

/** Flags that narrow a test or lint run to fewer files or tests. */
const NARROWING_RE =
  /(^|\s)(--exclude|--ignore(-pattern|-path)?|--testPathIgnorePatterns|--test-path-ignore-patterns|--testIgnore|--testNamePattern|--test-name-pattern|-t|--grep|--skip|--changed|--onlyChanged|-o|--findRelatedTests|--related|--shard|--no-error-on-unmatched-pattern)(?=\s|=|$)/;

/** Words that launch a tool rather than being the tool. */
const WRAPPERS = new Set([
  "npx",
  "pnpm",
  "pnpx",
  "npm",
  "yarn",
  "bun",
  "bunx",
  "exec",
  "run",
  "dlx",
  "cross-env",
  "dotenv",
  "env",
  "node",
  "--",
]);

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/** The tools a script runs: the first meaningful word of each command. */
export function scriptRunners(script: string): Set<string> {
  const runners = new Set<string>();
  for (const command of script.split(/\|\||&&|;|\||&/)) {
    const words = command.trim().split(/\s+/).filter(Boolean);
    const tool = words.find(
      (w) => !WRAPPERS.has(w) && !/^[A-Z_][A-Z0-9_]*=/.test(w) && !w.startsWith("-"),
    );
    // `node script.js` runs the script: keep its name as the tool.
    if (tool) runners.add(tool.replace(/^.*\//, ""));
  }
  return runners;
}

/** Why the new version of a guarded script can pass without doing the work, or null. */
export function neutralizedScript(was: string, now: string): string | null {
  if (NEUTRALIZER_RE.test(now) && !NEUTRALIZER_RE.test(was)) return "it can no longer fail";
  const runners = scriptRunners(now);
  const dropped = [...scriptRunners(was)].filter((r) => !runners.has(r));
  if (dropped.length > 0) return `it no longer runs ${dropped.join(", ")}`;
  for (const [name, re] of OPERATORS) {
    if (count(now, re) > count(was, re))
      return `"${name}" was added, which can hide a failing exit code`;
  }
  if (NARROWING_RE.test(now) && !NARROWING_RE.test(was)) return "it now skips files or tests";
  return null;
}
