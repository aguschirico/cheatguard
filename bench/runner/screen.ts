/**
 * Independent false-negative screening for real PRs: regex signals of shortcuts on changed lines
 * that cheatguard did not flag. Every candidate is then reviewed by hand (see corpus/LABELING.md).
 *
 *   node bench/runner/screen.ts --set agent
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { computeAddedLines } from "@cheatguard/core";
import { corpusSetOption, loadCases, runCase } from "./corpus-lib.ts";

const { values } = parseArgs({ options: { set: { type: "string", default: "agent" } } });
const ROOT = join(import.meta.dirname, "..", "corpus");
const SIGNALS: Array<[string, RegExp, "added" | "removed", RegExp?]> = [
  [
    "type-suppression",
    /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|biome-ignore|\bas any\b|:\s*any\b|as unknown as/,
    "added",
  ],
  [
    "test-weakened",
    /\b(it|test|describe)\.(skip|only|todo)\b|\bx(it|describe)\(/,
    "added",
    /test|spec/,
  ],
  ["test-weakened", /\bexpect\(|\bassert[.(]/, "removed", /test|spec/],
  [
    "swallowed-error",
    /catch\s*(\([^)]*\))?\s*\{\s*\}|\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/,
    "added",
  ],
  ["stub-left", /not\s+implemented|\bTODO\b|\bFIXME\b/i, "added"],
];
const lines = (t: string | null): string[] => (t ?? "").replace(/\r\n/g, "\n").split("\n");

for (const c of loadCases(ROOT, corpusSetOption(values.set))) {
  const flagged = new Set(runCase(c).predicted.map((v) => `${v.rule}|${v.file}`));
  for (const ch of c.changes) {
    if (!/\.[cm]?[jt]sx?$/.test(ch.path)) continue;
    const added =
      ch.after === null
        ? []
        : [...computeAddedLines(ch.before, ch.after)].map((n) => lines(ch.after)[n - 1] ?? "");
    const removed =
      ch.before === null
        ? []
        : [...computeAddedLines(ch.after, ch.before ?? "")].map(
            (n) => lines(ch.before)[n - 1] ?? "",
          );
    for (const [rule, re, side, fileRe] of SIGNALS) {
      if (fileRe && !fileRe.test(ch.path)) continue;
      const hits = (side === "added" ? added : removed).filter((l) => re.test(l));
      if (hits.length === 0 || flagged.has(`${rule}|${ch.path}`)) continue;
      console.log(
        `${c.id}\t${rule}\t${side}\t${ch.path}\t${hits.length}\t${hits[0]?.trim().slice(0, 140)}`,
      );
    }
  }
}
