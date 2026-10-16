import { randomInt } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
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

type Read = (fd: number, buffer: Buffer, offset: number, length: number, position: null) => number;

/**
 * Reads one line from a terminal descriptor (reads return at Enter). A shell can leave the
 * descriptor non-blocking, and then a read fails with EAGAIN until something is typed.
 */
export function readLineFrom(fd: number, read: Read = readSync): string {
  const buffer = Buffer.alloc(256);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const bytes = read(fd, buffer, 0, buffer.length, null);
      return buffer.subarray(0, bytes).toString("utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      Atomics.wait(pause, 0, 0, 50);
    }
  }
}

/** Reads the line from /dev/tty where there is one: a fresh descriptor blocks even if stdin doesn't. */
function readTypedLine(): string {
  if (process.platform === "win32") return readLineFrom(0);
  const fd = openSync("/dev/tty", "r");
  try {
    return readLineFrom(fd);
  } finally {
    closeSync(fd);
  }
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
      "cheatguard accept must be run by a person in an interactive terminal (agents should fix the issues instead). Claude Code's ! prefix is not one: run it in a separate terminal.",
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
