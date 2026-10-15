import ts from "typescript";
import type { FileFacts, LiteralEntry } from "../lang/adapter.js";
import { isRecord } from "../util/json.js";

export { type ConfigKind, configKindOf } from "../config-kind.js";

const BASENAME = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export function parseJsonc(text: string): unknown {
  const result = ts.parseConfigFileTextToJson("config.json", text);
  const config: unknown = result.config;
  return result.error ? undefined : config;
}

function lineOfKey(text: string, key: string): number {
  const index = text.indexOf(`"${key}"`);
  const at = index >= 0 ? index : text.indexOf(key);
  if (at < 0) return 1;
  return text.slice(0, at).split("\n").length;
}

/** Flattens JSON into the same key-path format the TS adapter uses for JS/TS config literals. */
export function flattenJson(value: unknown, text: string): LiteralEntry[] {
  const entries: LiteralEntry[] = [];
  const walk = (v: unknown, path: string, lastKey: string): void => {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      entries.push({ path, value: v, line: lineOfKey(text, lastKey) });
    } else if (Array.isArray(v)) {
      for (const [i, el] of v.entries()) walk(el, `${path}[${i}]`, lastKey);
    } else if (isRecord(v)) {
      for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k, k);
    }
  };
  walk(value, "", "");
  return entries;
}

/** Config entries for a file version: JSON(C) files are parsed, JS/TS configs come from adapter facts. */
export function configEntries(
  path: string,
  text: string | null,
  facts: FileFacts | null,
): LiteralEntry[] | null {
  if (text === null) return null;
  if (/\.jsonc?$/.test(path) || /^\.eslintrc$/.test(BASENAME(path))) {
    const parsed = parseJsonc(text);
    return parsed === undefined ? null : flattenJson(parsed, text);
  }
  return facts?.literals ?? null;
}
