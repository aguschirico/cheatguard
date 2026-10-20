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

/** The shell runs each line of a script as its own command, like `;`. */
const oneLine = (script: string): string => script.replace(/\r\n|\r|\n/g, ";");

/** Why the new version of a guarded script can pass without doing the work, or null. */
export function neutralizedScript(wasScript: string, nowScript: string): string | null {
  const was = oneLine(wasScript);
  const now = oneLine(nowScript);
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

const commands = (script: string): string[] =>
  script
    .split("&&")
    .map((c) => c.trim().replace(/\s+/g, " "))
    .filter(Boolean);

/** Everything but the last word: the program and flags a command runs its argument through. */
const head = (command: string): string => command.split(" ").slice(0, -1).join(" ");

/** `yarn tsc` → `tsc`: the package-manager prefix that runs a binary (or a script of that name). */
const RUNNER_PREFIX_RE = /^(npx|pnpx|bunx|yarn|pnpm( exec)?|npm exec|bun x) (?=[^-])/;

/** Programs that run, execute or destroy their argument: another argument is another program. */
const RUNS_ITS_ARGUMENT = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "tsx",
  "ts-node",
  "esno",
  "jiti",
  "python",
  "python3",
  "deno",
  "bun",
  "rm",
  "mv",
  "cp",
  "ln",
  "chmod",
  "git",
  "sed",
  "find",
  "xargs",
  "curl",
  "wget",
  "eval",
  "source",
]);

/** A head whose extra runs only check more files: a known program with its flags, never a runner. */
function repeatableHead(head: string): boolean {
  const words = head.split(" ").filter(Boolean);
  // `node --check` only parses; any other `node <flags>` runs its argument.
  if (words[0] === "node")
    return words.length === 2 && (words[1] === "--check" || words[1] === "-c");
  const program = words.find((w) => !WRAPPERS.has(w) && !w.startsWith("-"));
  return program !== undefined && !RUNS_ITS_ARGUMENT.has(program.replace(/^.*\//, ""));
}

/**
 * True when `now` runs every `&&`-chained command of `was` and at most adds more runs of a command
 * it already ran on other arguments (`node --check a.mjs && node --check b.mjs` gaining `&& node
 * --check c.mjs`). A command may also drop its package-manager prefix (`yarn tsc` → `tsc`): that
 * runs the binary itself, where the prefix could have run a script of the same name instead.
 */
export function sameChecksOrMore(was: string, now: string): boolean {
  // Anything but plain `&&` chains (pipes, `;`, new lines, `||`, substitutions) is judged by the
  // other checks.
  const plain = (s: string): boolean => !/[|;&`$<>\r\n]/.test(s.replaceAll("&&", ""));
  if (!plain(was) || !plain(now) || was === now) return false;
  const before = commands(was);
  const after = commands(now);
  const heads = new Set(before.map(head).filter(repeatableHead));
  let next = 0;
  for (const command of after) {
    const expected = before[next];
    if (
      expected !== undefined &&
      (command === expected || command === expected.replace(RUNNER_PREFIX_RE, ""))
    ) {
      next += 1;
    } else if (!heads.has(head(command)) || command.split(" ").at(-1)?.startsWith("-")) {
      // A new run must be the same check on another argument: `jest -u` is the same tool
      // rewriting snapshots before the real run.
      return false;
    }
  }
  return next === before.length;
}
