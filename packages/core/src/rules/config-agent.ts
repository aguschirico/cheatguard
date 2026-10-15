/**
 * Checks for the agent's own settings (.claude/settings.json and settings.local.json): an agent
 * must not be able to switch off the hooks that check it.
 */
import { parseJsonc } from "./config-files.js";

export interface AgentFinding {
  detail: string;
  fix: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Array.isArray narrows to any[]; keep elements unknown. */
const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** "event / matcher / command" for every hook command that runs cheatguard. */
function guardHooks(settings: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return found;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of asArray(groups)) {
      if (!isRecord(group)) continue;
      const matcher = typeof group.matcher === "string" ? group.matcher : "";
      for (const hook of asArray(group.hooks)) {
        if (
          isRecord(hook) &&
          typeof hook.command === "string" &&
          hook.command.includes("cheatguard")
        ) {
          found.add(`${event} / ${matcher || "*"} / ${hook.command}`);
        }
      }
    }
  }
  return found;
}

function guardPlugins(settings: Record<string, unknown>): Set<string> {
  const plugins = settings.enabledPlugins;
  if (!isRecord(plugins)) return new Set();
  return new Set(
    Object.entries(plugins)
      .filter(([name, enabled]) => name.includes("cheatguard") && enabled === true)
      .map(([name]) => name),
  );
}

function parse(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  const parsed = parseJsonc(text);
  return isRecord(parsed) ? parsed : {};
}

function strictJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function agentSettingsFindings(before: string | null, after: string | null): AgentFinding[] {
  const was = parse(before) ?? {};
  const now = parse(after) ?? {};
  const findings: AgentFinding[] = [];
  // The agent reads settings as strict JSON: a comment or trailing comma can drop the whole file.
  if (after !== null && !strictJson(after) && (before === null || strictJson(before))) {
    findings.push({
      detail:
        "The settings file is no longer valid JSON, so the agent may ignore it (and its hooks)",
      fix: "Make the file valid JSON again (no comments or trailing commas).",
    });
  }
  const nowHooks = guardHooks(now);
  const removed = [...guardHooks(was)].filter((h) => !nowHooks.has(h));
  if (removed.length > 0) {
    findings.push({
      detail: `cheatguard hook${removed.length > 1 ? "s were" : " was"} removed or changed: ${removed.join("; ")}`,
      fix: "Restore the cheatguard hooks; the agent must not change the checks that review its work.",
    });
  }
  const nowPlugins = guardPlugins(now);
  const disabled = [...guardPlugins(was)].filter((p) => !nowPlugins.has(p));
  if (disabled.length > 0) {
    findings.push({
      detail: `The cheatguard plugin was disabled: ${disabled.join(", ")}`,
      fix: "Re-enable the plugin in enabledPlugins.",
    });
  }
  if (now.disableAllHooks === true && was.disableAllHooks !== true) {
    findings.push({
      detail: "disableAllHooks was turned on, which switches cheatguard off",
      fix: "Remove disableAllHooks.",
    });
  }
  return findings;
}
