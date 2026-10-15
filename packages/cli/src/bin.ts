import { readFileSync } from "node:fs";
import { ConfigError, GitError, NotAGitRepoError, VERSION } from "@cheatguard/core";
import { ACCEPT_HELP, runAccept } from "./commands/accept.js";
import { CHECK_HELP, runCheck } from "./commands/check.js";
import { runRules, runSchema } from "./commands/info.js";
import { INIT_HELP, runInit } from "./commands/init.js";
import { LINT_HELP, runLintCommand } from "./commands/lint.js";
import { EXIT, UsageError } from "./errors.js";
import { runClaudeCodeHook } from "./hooks/claude-code.js";

const HELP = `cheatguard ${VERSION} — catch the shortcuts AI coding agents take

Usage:
  cheatguard check [paths...]      Check changed files for agent shortcuts (+ new lint/type errors)
  cheatguard lint                  Run eslint/biome/tsc and show only diagnostics you introduced
  cheatguard init claude-code      Install the Claude Code hooks in this repository
  cheatguard accept                Stop carrying over issues a released agent session left open
  cheatguard hook claude-code      Hook entry point (reads the hook payload from stdin)
  cheatguard rules                 List the rules
  cheatguard schema                Print the JSON schema of cheatguard.config.json

Run "cheatguard <command> --help" for options.

${CHECK_HELP}

${LINT_HELP}

${INIT_HELP}

${ACCEPT_HELP}`;

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${HELP}\n`);
      return EXIT.ok;
    case "--version":
    case "-v":
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return EXIT.ok;
    case "check":
      return runCheck(rest);
    case "lint":
      return runLintCommand(rest);
    case "init":
      return runInit(rest);
    case "accept":
      return runAccept(rest);
    case "rules":
      return runRules();
    case "schema":
      return runSchema();
    case "hook": {
      if (rest[0] !== "claude-code")
        throw new UsageError(`Unsupported hook "${rest[0] ?? ""}". Supported: claude-code`);
      return runClaudeCodeHook(readFileSync(0, "utf8"));
    }
    default:
      throw new UsageError(`Unknown command "${command}". Run "cheatguard --help".`);
  }
}

/** node:util parseArgs errors (unknown option, missing value...) are usage errors, not crashes. */
function isParseArgsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS_")
  );
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  const expected =
    isParseArgsError(error) ||
    error instanceof UsageError ||
    error instanceof ConfigError ||
    error instanceof NotAGitRepoError ||
    error instanceof GitError;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`cheatguard: ${message}\n`);
  if (isParseArgsError(error)) process.stderr.write('Run "cheatguard --help" for usage.\n');
  if (!expected && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = EXIT.toolError;
}
