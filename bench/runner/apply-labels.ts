/** Writes the hand labels in corpus/labels.json into the real-PR cases (expected flags + notes). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RULE_IDS } from "@cheatguard/core";
import { z } from "zod";
import { type CorpusSet, loadCases, writeCase } from "./corpus-lib.ts";

const ROOT = join(import.meta.dirname, "..", "corpus");
const labelSchema = z.record(z.string(), z.array(z.tuple([z.enum(RULE_IDS), z.string()])));
const labels = z
  .object({ agent: labelSchema, human: labelSchema, notes: z.record(z.string(), z.string()) })
  .parse(JSON.parse(readFileSync(join(ROOT, "labels.json"), "utf8")));
const REAL_SETS: CorpusSet[] = ["agent", "human"];
for (const set of REAL_SETS) {
  const forSet = set === "agent" ? labels.agent : labels.human;
  let positives = 0;
  const cases = loadCases(ROOT, set);
  for (const c of cases) {
    const flags = forSet[c.id] ?? [];
    c.expected = flags.map(([rule, file]) => ({ rule, file }));
    c.notes = "LABELED v2 (single annotator, AI-assisted; see corpus/LABELING.md)";
    if (flags.length > 0) positives += 1;
    writeCase(ROOT, c);
  }
  const unknown = Object.keys(forSet).filter((id) => !cases.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`labels for unknown ${set} cases: ${unknown.join(", ")}`);
  console.log(`${set}: ${cases.length} cases labeled, ${positives} with expected flags`);
}
