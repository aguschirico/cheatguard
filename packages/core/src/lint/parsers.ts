import { asArray, isRecord } from "../util/json.js";
import { toRepoPath } from "./paths.js";
import type { Diagnostic } from "./types.js";

const num = (v: unknown, fallback = 1): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export function parseEslintJson(output: string, root: string): Diagnostic[] {
  const start = output.indexOf("[");
  if (start === -1) throw new Error("ESLint did not produce JSON output");
  const parsed: unknown = JSON.parse(output.slice(start));
  if (!Array.isArray(parsed)) throw new Error("Unexpected ESLint JSON shape");
  const diagnostics: Diagnostic[] = [];
  for (const file of parsed) {
    if (!isRecord(file) || typeof file.filePath !== "string") continue;
    for (const m of asArray(file.messages)) {
      if (!isRecord(m)) continue;
      const message = typeof m.message === "string" ? m.message : "";
      const ruleId = typeof m.ruleId === "string" ? m.ruleId : null;
      if (!ruleId && m.fatal !== true && message.startsWith("File ignored")) continue;
      diagnostics.push({
        tool: "eslint",
        file: toRepoPath(root, file.filePath),
        line: num(m.line),
        column: num(m.column),
        code: ruleId ?? (m.fatal === true ? "parse" : "eslint"),
        message,
        severity: m.severity === 2 ? "error" : "warning",
      });
    }
  }
  return diagnostics;
}

function unescapeGithub(value: string): string {
  return value
    .replace(/%0D/gi, "")
    .replace(/%0A/gi, " ")
    .replace(/%3A/gi, ":")
    .replace(/%2C/gi, ",")
    .replace(/%25/g, "%");
}

const GITHUB_RE = /^::(error|warning|notice)\s+([^:]*?)::(.*)$/;

export function parseBiomeGithub(output: string, root: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = GITHUB_RE.exec(raw.trim());
    if (!match) continue;
    const [, level = "warning", props = "", message = ""] = match;
    const fields = new Map<string, string>();
    for (const part of props.split(",")) {
      const eq = part.indexOf("=");
      if (eq > 0) fields.set(part.slice(0, eq), unescapeGithub(part.slice(eq + 1)));
    }
    const file = fields.get("file");
    if (!file) continue;
    diagnostics.push({
      tool: "biome",
      file: toRepoPath(root, file),
      line: Number(fields.get("line") ?? 1),
      column: Number(fields.get("col") ?? 1),
      code: fields.get("title") ?? "biome",
      message: unescapeGithub(message).trim(),
      severity: level === "error" ? "error" : "warning",
    });
  }
  return diagnostics;
}

const TSC_RE = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;

export function parseTscOutput(output: string, root: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let last: Diagnostic | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const match = TSC_RE.exec(raw);
    if (match) {
      const [, file = "", line = "1", column = "1", level = "error", code = "", message = ""] =
        match;
      last = {
        tool: "tsc",
        file: toRepoPath(root, file),
        line: Number(line),
        column: Number(column),
        code,
        message: message.trim(),
        severity: level === "error" ? "error" : "warning",
      };
      diagnostics.push(last);
    } else if (last && /^\s+\S/.test(raw)) {
      last.message = `${last.message} ${raw.trim()}`;
    } else if (raw.trim() !== "") {
      last = null;
    }
  }
  return diagnostics;
}
