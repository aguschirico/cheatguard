import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { repoRoot } from "@cheatguard/core";
import { EXIT, UsageError } from "../errors.js";

export const INIT_HELP = `cheatguard init claude-code [--command <cmd>]

Adds cheatguard's SessionStart, PostToolUse and Stop hooks to .claude/settings.json
(merging with what is there).

  --command <cmd>   How to invoke cheatguard (default: "npx --no-install cheatguard")`;

/** Matches `cheatguard hook claude-code` and versioned forms like `cheatguard@0.1.0 hook claude-code`. */
const MARKER_RE = /\bcheatguard(@\S+)?\s+hook\s+claude-code\b/;

interface HookHandler {
  type: "command";
  command: string;
  timeout: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A hook group installed by cheatguard (any version or command prefix). */
function isOurs(group: unknown): boolean {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
  const handlers: readonly unknown[] = group.hooks;
  return handlers.some(
    (h) => isRecord(h) && typeof h.command === "string" && MARKER_RE.test(h.command),
  );
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new UsageError(`${path} is not valid JSON; fix it before running init`);
  }
  if (!isRecord(parsed)) throw new UsageError(`${path} must contain a JSON object`);
  return parsed;
}

export function runInit(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      command: { type: "string", default: "npx --no-install cheatguard" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${INIT_HELP}\n`);
    return EXIT.ok;
  }
  if (positionals[0] !== "claude-code")
    throw new UsageError(`Unsupported agent "${positionals[0] ?? ""}". Supported: claude-code`);
  const root = repoRoot(process.cwd());
  const settingsPath = join(root, ".claude", "settings.json");
  const settings = readSettings(settingsPath);
  const current = settings.hooks ?? {};
  if (!isRecord(current)) throw new UsageError(`"hooks" in ${settingsPath} must be an object`);
  const command = `${values.command} hook claude-code`;
  const ours: Record<string, HookGroup> = {
    SessionStart: { hooks: [{ type: "command", command, timeout: 60 }] },
    PostToolUse: {
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command, timeout: 60 }],
    },
    Stop: { hooks: [{ type: "command", command, timeout: 300 }] },
  };
  const hooks: Record<string, unknown> = { ...current };
  for (const [event, group] of Object.entries(ours)) {
    const existing = hooks[event] ?? [];
    if (!Array.isArray(existing))
      throw new UsageError(`"hooks.${event}" in ${settingsPath} must be an array`);
    const groups: readonly unknown[] = existing;
    // Other tools' hooks are kept exactly as they are, whatever their shape.
    hooks[event] = [...groups.filter((g) => !isOurs(g)), group];
  }
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);

  process.stdout.write(
    `cheatguard hooks installed in ${settingsPath}\nRestart Claude Code (or run /hooks) to load them.\n`,
  );
  return EXIT.ok;
}
