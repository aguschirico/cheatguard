import { randomInt } from "node:crypto";
import { readSync } from "node:fs";
import { parseArgs } from "node:util";
import { clearRelease, loadRelease, logIntervention, repoRoot } from "@cheatguard/core";
import { EXIT, UsageError } from "../errors.js";

export const ACCEPT_HELP = `cheatguard accept

When an agent session ends with blocking issues still open (after hooks.maxStopBlocks attempts),
cheatguard keeps checking them in the next sessions. Run this after you have reviewed those
changes to stop carrying them over. It must be run by a person in an interactive terminal: it
refuses to run without a TTY or inside a Claude Code tool call, and asks you to type a random code.`;

/** A person at a terminal, not an agent's tool call (Claude Code sets CLAUDECODE=1 for its tools). */
export function interactiveHuman(): boolean {
  return (
    process.stdin.isTTY === true && process.stdout.isTTY === true && process.env.CLAUDECODE !== "1"
  );
}

/** Reads one line typed at the terminal (stdin is a TTY here, so reads return at Enter). */
function readTypedLine(): string {
  const buffer = Buffer.alloc(256);
  const bytes = readSync(0, buffer, 0, buffer.length, null);
  return buffer.subarray(0, bytes).toString("utf8").trim();
}

export function runAccept(
  argv: string[],
  human = interactiveHuman(),
  readLine: () => string = readTypedLine,
): number {
  const { values } = parseArgs({
    args: argv,
    options: { help: { type: "boolean", short: "h", default: false } },
  });
  if (values.help) {
    process.stdout.write(`${ACCEPT_HELP}\n`);
    return EXIT.ok;
  }
  if (!human) {
    throw new UsageError(
      "cheatguard accept must be run by a person in an interactive terminal (agents should fix the issues instead)",
    );
  }
  const root = repoRoot(process.cwd());
  const release = loadRelease(root);
  if (!release) {
    process.stdout.write("Nothing to accept: no session ended with open issues.\n");
    return EXIT.ok;
  }
  // A random code a non-interactive command cannot know in advance.
  const code = String(randomInt(100_000, 1_000_000));
  process.stdout.write(
    `Session ${release.session || "(unknown)"} ended on ${release.time} with blocking issues open.\nType ${code} to accept them: `,
  );
  if (readLine() !== code) {
    process.stdout.write("\nNot accepted.\n");
    return EXIT.violations;
  }
  clearRelease(root);
  logIntervention(root, {
    session: release.session,
    event: "accept",
    decision: "released",
    rules: [],
    files: [],
  });
  process.stdout.write(
    `Accepted the open issues from session ${release.session || "(unknown)"} (${release.time}). New sessions start from the current working tree.\n`,
  );
  return EXIT.ok;
}
