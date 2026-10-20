import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  CORPUS_SETS,
  type CorpusCase,
  type CorpusSet,
  changedLines,
  corpusSetOption,
  loadCases,
  percentile,
  type RuleScore,
  runCase,
  score,
} from "./corpus-lib.ts";

const { values } = parseArgs({
  options: {
    set: { type: "string", default: "all" },
    out: { type: "string", default: join(import.meta.dirname, "..", "results") },
    errors: { type: "boolean", default: false },
    // Compare with the committed results instead of overwriting them (CI).
    check: { type: "boolean", default: false },
  },
});

const ROOT = join(import.meta.dirname, "..", "corpus");
const SETS: CorpusSet[] = values.set === "all" ? [...CORPUS_SETS] : [corpusSetOption(values.set)];

const fmt = (n: number | null): string => (n === null ? "—" : n.toFixed(2));

const sets: Record<string, Record<string, unknown>> = {};
const scoresBySet: Partial<Record<CorpusSet, RuleScore>> = {};
const committedSchema = z.object({ sets: z.record(z.string(), z.record(z.string(), z.unknown())) });
const stable = (set: Record<string, unknown> | undefined): string => {
  if (set === undefined) return "missing";
  const { latencyMs: _latency, ...rest } = set;
  return JSON.stringify(rest);
};
const report = { generatedAt: new Date().toISOString(), sets };
const lines: string[] = [
  "# Benchmark A — labeled corpus",
  "",
  `Generated ${new Date().toISOString().slice(0, 10)}.`,
  "",
];

for (const set of SETS) {
  const cases: CorpusCase[] = loadCases(ROOT, set);
  if (cases.length === 0) continue;
  const results = cases.map(runCase);
  const scored = score(cases, results);
  const durations = results.map((r) => r.durationMs);
  const lineCount = cases.reduce((n, c) => n + changedLines(c), 0);
  const flags = results.reduce(
    (n, r) => n + new Set(r.predicted.map((v) => `${v.rule}|${v.file}`)).size,
    0,
  );
  const blockFlags = results.reduce(
    (n, r) =>
      n +
      new Set(r.predicted.filter((v) => v.severity === "block").map((v) => `${v.rule}|${v.file}`))
        .size,
    0,
  );
  const expectedKeys = new Set(
    cases.flatMap((c) => c.expected.map((e) => `${c.id}|${e.rule}|${e.file}`)),
  );
  let tpBlock = 0;
  for (const r of results) {
    const seenBlock = new Set<string>();
    for (const v of r.predicted) {
      if (v.severity !== "block") continue;
      const key = `${r.id}|${v.rule}|${v.file}`;
      if (seenBlock.has(key)) continue;
      seenBlock.add(key);
      if (expectedKeys.has(key)) tpBlock += 1;
    }
  }
  const fpBlock = scored.errors.filter(
    (e) =>
      e.kind === "fp" &&
      results
        .find((r) => r.id === e.id)
        ?.predicted.some((v) => v.rule === e.rule && v.file === e.file && v.severity === "block"),
  ).length;
  scoresBySet[set] = scored.overall;
  sets[set] = {
    cases: cases.length,
    changedLines: lineCount,
    flags,
    blockFlags,
    blockPrecision: blockFlags === 0 ? null : tpBlock / blockFlags,
    falseBlockFlagsPer1000Lines: lineCount === 0 ? 0 : (fpBlock / lineCount) * 1000,
    latencyMs: {
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: Math.max(...durations),
    },
    overall: scored.overall,
    perRule: scored.perRule,
    errors: scored.errors,
  };
  lines.push(`## ${set} (${cases.length} cases, ${lineCount} changed lines)`, "");
  lines.push(
    "| rule | TP | FP | FN | precision | recall | F1 |",
    "|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const [rule, s] of Object.entries(scored.perRule)) {
    if (s.tp + s.fp + s.fn === 0) continue;
    lines.push(
      `| ${rule} | ${s.tp} | ${s.fp} | ${s.fn} | ${fmt(s.precision)} | ${fmt(s.recall)} | ${fmt(s.f1)} |`,
    );
  }
  const o = scored.overall;
  lines.push(
    `| **all** | ${o.tp} | ${o.fp} | ${o.fn} | ${fmt(o.precision)} | ${fmt(o.recall)} | ${fmt(o.f1)} |`,
    "",
  );
  lines.push(
    `False blocking flags per 1,000 changed lines: ${lineCount === 0 ? "—" : ((fpBlock / lineCount) * 1000).toFixed(2)} · latency p50 ${percentile(durations, 50).toFixed(1)} ms, p95 ${percentile(durations, 95).toFixed(1)} ms`,
    "",
  );
  if (values.errors) {
    for (const e of scored.errors)
      console.log(
        `${set} ${e.kind.toUpperCase()} ${e.rule} ${e.id} ${e.file}${e.detail ? ` — ${e.detail}` : ""}`,
      );
  }
}

console.log(lines.join("\n"));

if (values.check) {
  process.exitCode = checkAgainstCommitted() ? 0 : 1;
} else {
  writeFileSync(join(values.out, "corpus-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(values.out, "corpus-latest.md"), `${lines.join("\n")}\n`);
}

/**
 * Scores are deterministic (latency is not), so any change in what the rules report on the
 * corpus shows up here: the pull request has to rerun the benchmark and commit the new results.
 */
function checkAgainstCommitted(): boolean {
  const committed = committedSchema.parse(
    JSON.parse(readFileSync(join(values.out, "corpus-latest.json"), "utf8")),
  );
  let ok = true;
  const synthetic = scoresBySet.synthetic;
  if (synthetic && (synthetic.fp > 0 || synthetic.fn > 0)) {
    console.error(
      `synthetic set is no longer perfect: ${synthetic.fp} wrong, ${synthetic.fn} missed`,
    );
    ok = false;
  }
  for (const set of SETS) {
    if (stable(sets[set]) !== stable(committed.sets[set])) {
      console.error(
        `${set}: scores differ from bench/results/corpus-latest.json. Run \`node bench/runner/corpus.ts --errors\`, review the changed flags and commit the new results.`,
      );
      ok = false;
    }
  }
  return ok;
}
