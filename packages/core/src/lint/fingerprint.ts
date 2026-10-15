import type { Diagnostic } from "./types.js";

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Line-number-free identity of each diagnostic: tool, rule, file, message and the offending line's
 * text, plus an occurrence index so repeated identical diagnostics stay distinct.
 */
export function fingerprintAll(
  diagnostics: readonly Diagnostic[],
  readLine: (file: string, line: number) => string,
): string[] {
  const seen = new Map<string, number>();
  return diagnostics.map((d) => {
    const key = [
      d.tool,
      d.code,
      d.file,
      normalize(d.message),
      normalize(readLine(d.file, d.line)),
    ].join("\u0000");
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return `${key}\u0000${occurrence}`;
  });
}
