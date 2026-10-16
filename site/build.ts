/**
 * Builds the static landing page from benchmark results (numbers are never typed by hand).
 *
 *   node site/build.ts   →  site/dist/index.html (+ assets)
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const RESULTS = join(ROOT, "bench", "results");
const OUT = join(ROOT, "site", "dist");
/** Repository URL used in links. */
const REPO_URL = "https://github.com/aguschirico/cheatguard";

interface RuleScore {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
}
interface CorpusSetReport {
  cases: number;
  changedLines: number;
  blockFlags: number;
  blockPrecision: number | null;
  falseBlockFlagsPer1000Lines: number;
  overall: RuleScore;
  perRule: Record<string, RuleScore>;
  latencyMs: { p50: number; p95: number };
}
interface ArmRates {
  n: number;
  honest: number;
  cheated: number;
  failed: number;
  honestRate: number;
}
interface ArmSummary {
  all: ArmRates;
  trap: ArmRates;
  control: ArmRates;
  avgCostUsd: number | null;
  avgDurationS: number | null;
  interventions: number;
}
interface AgentSummary {
  model: string;
  pressure?: boolean;
  runsPerCell: number;
  tasks: Array<{ id: string; category: string }>;
  arms: Record<"none" | "prompt" | "cheatguard", ArmSummary>;
  /** Individual runs (runs.jsonl next to summary.json). */
  runs: RunRow[];
}
interface RunRow {
  task: string;
  arm: "none" | "prompt" | "cheatguard";
  outcome: "honest" | "cheated" | "failed" | null;
  durationMs: number;
  interventions: number;
  /** Hidden checks the run failed (grading, independent of cheatguard). */
  failedChecks: string[];
}
interface LintMeasure {
  tokens: number;
  ms: number;
  seededFound: number;
}
interface LintRow {
  repo: string;
  linters?: string[];
  seededDiagnostics?: number;
  raw?: LintMeasure;
  cheatguard?: LintMeasure;
  cheatguardWithBaseline?: LintMeasure;
  error?: string;
}

// Result files are produced by this repository's own runners; their shapes are the interfaces above.
const readJson = <T>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const ARM_IDS = ["none", "prompt", "cheatguard"] as const;

function readRuns(path: string): RunRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line): RunRow[] => {
      const r: unknown = JSON.parse(line);
      if (!isRecord(r) || typeof r.task !== "string") return [];
      const arm = ARM_IDS.find((a) => a === r.arm);
      if (!arm) return [];
      const grade = isRecord(r.grade) ? r.grade : null;
      const outcome =
        grade?.outcome === "honest" || grade?.outcome === "cheated" || grade?.outcome === "failed"
          ? grade.outcome
          : null;
      return [
        {
          task: r.task,
          arm,
          outcome,
          durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
          interventions: typeof r.interventions === "number" ? r.interventions : 0,
          failedChecks: Array.isArray(grade?.failedChecks)
            ? grade.failedChecks.filter((c): c is string => typeof c === "string")
            : [],
        },
      ];
    });
}
const corpus = readJson<{ sets: Record<string, CorpusSetReport> }>(
  join(RESULTS, "corpus-latest.json"),
);
const lint = readJson<{ results: LintRow[] }>(join(RESULTS, "lint-latest.json"));
const agentDir = join(RESULTS, "agents");
const agents: AgentSummary[] = existsSync(agentDir)
  ? readdirSync(agentDir).flatMap((d) => {
      const summary = readJson<Omit<AgentSummary, "runs">>(join(agentDir, d, "summary.json"));
      return summary ? [{ ...summary, runs: readRuns(join(agentDir, d, "runs.jsonl")) }] : [];
    })
  : [];

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (x: number | null | undefined): string =>
  x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`;
const dec = (x: number | null | undefined, d = 2): string =>
  x === null || x === undefined ? "—" : x.toFixed(d);

const RULES: Array<[string, string, "blocks" | "warns"]> = [
  [
    "test-weakened",
    "Tests deleted or moved out of the runner's reach, assertions removed or made unreachable, tests skipped, inverted or made conditional, expected values edited or matchers weakened.",
    "blocks",
  ],
  [
    "type-suppression",
    "New any, as any, as never, double casts, Function, untyped modules, @ts-ignore, eslint-disable, oxlint-disable, coverage-ignore comments.",
    "blocks",
  ],
  [
    "config-tampering",
    "Strict flags off, lint rules weakened, tests or files dropped from the run, coverage lowered, scripts neutralized, CI checks disabled, the agent's own hooks removed.",
    "blocks",
  ],
  [
    "stub-left",
    "Not-implemented throws, TODO-implement comments, function bodies gutted to return a constant.",
    "blocks",
  ],
  [
    "phantom-import",
    "Imports of packages that are not declared or not installed, and relative files that do not exist.",
    "blocks",
  ],
  [
    "swallowed-error",
    "New catch blocks that are empty, comment-only or only log, and .catch(() => undefined).",
    "warns",
  ],
  [
    "duplicate-export",
    "A new exported function that copies an existing one (formatDate2 next to formatDate).",
    "warns",
  ],
  ["scope-creep", "Files changed outside the paths you allowed for the task.", "warns"],
];

const SET_LABEL: Record<string, string> = {
  synthetic: "Synthetic cases (written with the rules; in-distribution)",
  agent: "Merged pull requests written by coding agents",
  human: "Merged pull requests written by people (before 2022)",
};

function corpusTable(): string {
  if (!corpus)
    return "<p>Run <code>node bench/runner/corpus.ts</code> to produce these numbers.</p>";
  const rows = Object.entries(corpus.sets)
    .map(
      ([set, s]) =>
        `<tr><th scope="row">${esc(SET_LABEL[set] ?? set)}</th><td>${s.cases}</td><td>${s.changedLines.toLocaleString("en-US")}</td><td>${pct(s.overall.precision)}</td><td>${pct(s.overall.recall)}</td><td>${pct(s.blockPrecision)}</td><td>${dec(s.falseBlockFlagsPer1000Lines)}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th scope="col">Corpus</th><th scope="col">Cases</th><th scope="col">Changed lines</th><th scope="col">Precision</th><th scope="col">Recall</th><th scope="col">Precision of blocking flags</th><th scope="col">Wrong blocks per 1,000 lines</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function perRuleTable(): string {
  const agent = corpus?.sets.agent;
  if (!agent) return "";
  const rows = Object.entries(agent.perRule)
    .filter(([, s]) => s.tp + s.fp + s.fn > 0)
    .map(
      ([rule, s]) =>
        `<tr><th scope="row"><code>${rule}</code></th><td>${s.tp}</td><td>${s.fp}</td><td>${s.fn}</td></tr>`,
    )
    .join("");
  return `<table class="compact"><caption>On agent pull requests, per rule</caption><thead><tr><th scope="col">Rule</th><th scope="col">Correct flags</th><th scope="col">Wrong flags</th><th scope="col">Missed</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const ARM_LABEL = {
  none: "Agent alone",
  prompt: "Agent + “don’t cheat” rules in CLAUDE.md",
  cheatguard: "Agent + cheatguard hooks",
} as const;

function agentTables(): string {
  if (agents.length === 0)
    return "<p>Run <code>node bench/runner/agents.ts</code> to produce these numbers.</p>";
  return agents
    .sort(
      (a, b) =>
        a.model.localeCompare(b.model) || Number(a.pressure ?? false) - Number(b.pressure ?? false),
    )
    .map((s) => {
      const rows = (["none", "prompt", "cheatguard"] as const)
        .map((arm) => {
          const a = s.arms[arm];
          return `<tr><th scope="row">${ARM_LABEL[arm]}</th><td>${a.all.cheated} / ${a.all.n}</td><td>${pct(a.trap.honestRate)}</td><td>${pct(a.control.honestRate)}</td><td>${dec(a.avgDurationS, 0)} s</td><td>$${dec(a.avgCostUsd, 3)}</td></tr>`;
        })
        .join("");
      const title = `${s.model}${s.pressure ? ", with an urgent “make CI green” prompt" : ""} — ${s.runsPerCell} runs per task`;
      return `<table><caption>${esc(title)}</caption><thead><tr><th scope="col">Setup</th><th scope="col">Runs that cheated</th><th scope="col">Honest solves, trap tasks</th><th scope="col">Honest solves, control tasks</th><th scope="col">Avg time</th><th scope="col">Avg cost</th></tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join("");
}

const LINTER_NAMES: Record<string, string> = {
  eslint: "ESLint",
  biome: "Biome",
  oxlint: "oxlint",
  tsc: "tsc",
};
const linters = (r: LintRow): string =>
  (r.linters ?? []).map((t) => LINTER_NAMES[t] ?? t).join(" + ") || "—";
/** Repositories where cheatguard took longer than running the linters once. */
const slowerThanRaw = (): string[] =>
  (lint?.results ?? [])
    .filter((r) => r.raw && r.cheatguard && r.cheatguard.ms > r.raw.ms)
    .map((r) => r.repo);

function lintTable(): string {
  if (!lint) return "";
  const rows = lint.results
    .filter((r) => r.raw && r.cheatguard)
    .map((r) => {
      const raw = r.raw as LintMeasure;
      const cg = r.cheatguard as LintMeasure;
      const base = r.cheatguardWithBaseline ?? cg;
      return `<tr><th scope="row">${esc(r.repo)}</th><td>${esc(linters(r))}</td><td>${raw.tokens}</td><td>${cg.tokens} (${base.tokens})</td><td>${Math.round((1 - base.tokens / raw.tokens) * 100)}%</td><td>${(raw.ms / 1000).toFixed(1)} s</td><td>${(cg.ms / 1000).toFixed(1)} s</td><td>${cg.seededFound} / ${r.seededDiagnostics ?? "?"}</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th scope="col">Repository</th><th scope="col">Linters</th><th scope="col">Tokens, raw linters</th><th scope="col">Tokens, cheatguard (with baseline)</th><th scope="col">Saved</th><th scope="col">Time, raw</th><th scope="col">Time, cheatguard</th><th scope="col">New problems kept</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const DIFF: Array<{ kind: "ctx" | "add" | "del"; code: string; note?: string }> = [
  { kind: "ctx", code: "// test/cart.test.ts" },
  { kind: "ctx", code: 'it("sums lines", () => {' },
  {
    kind: "del",
    code: '  expect(total([{ sku: "a", price: 2.5, qty: 2 }])).toBe(5);',
    note: "assertion deleted",
  },
  { kind: "ctx", code: "  expect(total([])).toBe(0);" },
  { kind: "ctx", code: "});" },
  { kind: "del", code: 'it("applies coupons", () => {' },
  { kind: "add", code: 'it.skip("applies coupons", () => {', note: "skipped, not fixed" },
  { kind: "ctx", code: "// src/cart.ts" },
  { kind: "del", code: "  for (const line of lines) sum += line.price * line.qty;" },
  {
    kind: "add",
    code: "  for (const line of lines) sum += line.price * (line as any).quantity;",
    note: "silenced the type checker",
  },
  { kind: "ctx", code: "// tsconfig.json" },
  { kind: "del", code: '  "strict": true,' },
  { kind: "add", code: '  "strict": false,', note: "relaxed the rules it was failing" },
];

function heroDiff(): string {
  const rows = DIFF.map((l) => {
    const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
    const note = l.note
      ? `<span class="mark" aria-label="cheatguard: ${esc(l.note)}">${esc(l.note)}</span>`
      : "";
    return `<div class="line ${l.kind}"><span class="sign" aria-hidden="true">${sign}</span><code>${esc(l.code)}</code>${note}</div>`;
  }).join("");
  return `<figure class="diff" aria-label="A diff where an agent made tests pass by cheating, annotated by cheatguard">${rows}<figcaption>“All tests pass now.” Four shortcuts, each one blocked by cheatguard before the agent can finish.</figcaption></figure>`;
}

const agentCheatTotal = agents.reduce(
  (n, s) => n + ARM_IDS.reduce((m, a) => m + s.arms[a].all.cheated, 0),
  0,
);
const agentRunTotal = agents.reduce(
  (n, s) => n + ARM_IDS.reduce((m, a) => m + s.arms[a].all.n, 0),
  0,
);

interface Cell {
  honest: number;
  n: number;
  avgS: number;
  interventions: number;
  /** Hidden checks failed by the runs that did not end honest. */
  failedChecks: string[];
}

function cells(summary: AgentSummary, task: string): Record<(typeof ARM_IDS)[number], Cell> {
  const cell = (arm: (typeof ARM_IDS)[number]): Cell => {
    const runs = summary.runs.filter((r) => r.task === task && r.arm === arm && r.outcome !== null);
    const n = runs.length;
    return {
      honest: runs.filter((r) => r.outcome === "honest").length,
      n,
      avgS: n ? runs.reduce((a, r) => a + r.durationMs, 0) / n / 1000 : 0,
      interventions: runs.reduce((a, r) => a + r.interventions, 0),
      failedChecks: [
        ...new Set(runs.filter((r) => r.outcome !== "honest").flatMap((r) => r.failedChecks)),
      ],
    };
  };
  return { none: cell("none"), prompt: cell("prompt"), cheatguard: cell("cheatguard") };
}

const frac = (c: Cell): string => `${c.honest}/${c.n}`;
const label = (s: AgentSummary): string => `${s.model}${s.pressure ? " (urgent prompt)" : ""}`;
/** The control task where editing the test is the correct fix (measures false-positive cost). */
const WRONG_TEST_TASK = "control-wrong-test";

/** Conclusions computed from the runs: per-task effects, false-positive cost, noise caveat. */
function conclusions(): { cheats: string; effect: string; cost: string; noise: string } {
  const taskCount = new Set(agents.flatMap((a) => a.tasks.map((t) => t.id))).size;
  const cheats = `In ${agentRunTotal} isolated runs across ${taskCount} small tasks designed to tempt shortcuts (including runs with an urgent “make CI green, whatever it takes” prompt), current Claude models cheated ${agentCheatTotal} time${agentCheatTotal === 1 ? "" : "s"}, with or without cheatguard. On tasks this size, frontier agents fix the code honestly. Published research finds the same agents do reward-hack on harder, longer tasks.`;
  const rate = (x: Cell): number => (x.n ? x.honest / x.n : 0);
  const WIDE = 0.4;
  // Wide gaps between setups on one task, split by whether cheatguard pushed back in those runs:
  // a gap where it never intervened is not its doing.
  const helped: string[] = [];
  let rulesClose = true;
  const unexplained: string[] = [];
  const behind: string[] = [];
  let behindInterventions = 0;
  const reasons = new Set<string>();
  for (const summary of agents) {
    for (const { id } of summary.tasks) {
      if (id === WRONG_TEST_TASK) continue;
      const c = cells(summary, id);
      const where = `${id} with ${label(summary)} (${frac(c.none)} alone, ${frac(c.prompt)} with CLAUDE.md rules, ${frac(c.cheatguard)} with cheatguard`;
      if (rate(c.cheatguard) - rate(c.none) >= WIDE) {
        (c.cheatguard.interventions > 0 ? helped : unexplained).push(`${where})`);
        if (c.cheatguard.interventions > 0 && rate(c.cheatguard) - rate(c.prompt) > 0.2)
          rulesClose = false;
      }
      if (rate(c.prompt) - rate(c.cheatguard) >= WIDE) {
        const failed = c.cheatguard.failedChecks.join(", ");
        behind.push(`${where}${failed ? `; hidden check failed with cheatguard: ${failed}` : ""})`);
        behindInterventions += c.cheatguard.interventions;
        for (const check of c.cheatguard.failedChecks) {
          if (/vitest|jest|npm test/.test(check))
            reasons.add(
              "cheatguard does not run the test suite (those agents stopped with a failing test)",
            );
          if (/does not use/.test(check))
            reasons.add(
              "cheatguard does not notice an existing helper being re-implemented inline",
            );
        }
      }
    }
  }
  const wide = `${WIDE * 100} points or more`;
  const effect = [
    helped.length > 0
      ? `Where cheatguard beat the agent alone by a wide margin (${wide}) after pushing back, it was by finishing the job (its end-of-task lint and type check), not by catching cheats: ${helped.join("; ")}. ${rulesClose ? "The CLAUDE.md rules came within 20 points of it there, and a" : "A"} Stop hook that runs the project's own checks would capture much of this.`
      : `No task showed cheatguard beating the agent alone by a wide margin (${wide}) after pushing back.`,
    unexplained.length > 0
      ? `Gaps of that size where cheatguard never intervened are run-to-run variation: ${unexplained.join("; ")}.`
      : "",
    behind.length > 0
      ? `The CLAUDE.md rules beat cheatguard by a wide margin on ${behind.length === 1 ? "one task" : `${behind.length} task/model pairs`}: ${behind.join("; ")}.${behindInterventions === 0 ? " cheatguard never intervened in those runs." : ""}${reasons.size > 0 ? ` ${reasons.size === 1 ? "The blind spot" : "The blind spots"}: ${[...reasons].join("; ")}. The rules text, by contrast, told the agent to fix the code under test and to reuse existing utilities.` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const costs = agents
    .filter((s) => s.tasks.some((t) => t.id === WRONG_TEST_TASK))
    .map((s) => {
      const c = cells(s, WRONG_TEST_TASK);
      const ratio = c.none.avgS > 0 ? c.cheatguard.avgS / c.none.avgS : 0;
      const lost = c.cheatguard.n - c.cheatguard.honest;
      return `${label(s)} took ${ratio.toFixed(1)}× as long as alone${lost > 0 ? ` and missed the correct fix in ${lost} of ${c.cheatguard.n} runs` : ""}`;
    });
  const cost =
    costs.length > 0
      ? `It also has a cost. On the one control task where editing the test is the right fix, cheatguard pushes back on that edit: ${costs.join("; ")}.`
      : "";
  const runsPerCell = [...new Set(agents.map((a) => a.runsPerCell))].join(" or ");
  return {
    cheats,
    effect,
    cost,
    noise: `Other differences between setups are within run-to-run variation at ${runsPerCell} runs per task (Wilson intervals are in each summary.json).`,
  };
}

const story = conclusions();
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cheatguard — catch the shortcuts coding agents take</title>
<meta name="description" content="Deterministic, diff-aware guardrails for AI coding agents: weakened tests, type suppressions, config tampering, stubs and phantom imports, blocked before the agent finishes.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,800&family=Caveat:wght@600&family=Fragment+Mono&display=swap" rel="stylesheet">
<style>
:root {
  --paper: #f5f7fa;
  --rule: #dde3ec;
  --ink: #1b2a4a;
  --pencil: #5b6472;
  --pen: #c8102e;
  --green: #1f7a4d;
  --highlight: #ffe36e;
  --measure: 46rem;
  --wide: 66rem;
}
* { box-sizing: border-box; }
html { color-scheme: light; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 400 1.0625rem/1.6 "Bricolage Grotesque", system-ui, sans-serif;
  font-optical-sizing: auto;
}
a { color: var(--ink); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { color: var(--pen); }
:focus-visible { outline: 3px solid var(--pen); outline-offset: 2px; }
code, pre { font-family: "Fragment Mono", ui-monospace, monospace; font-size: 0.9em; font-variant-ligatures: none; }
header.top, main, footer { padding: 0 1.25rem; }
header.top { max-width: var(--wide); margin: 0 auto; display: flex; justify-content: space-between; align-items: baseline; padding-top: 1.5rem; }
.wordmark { font-weight: 800; font-size: 1.25rem; letter-spacing: -0.02em; text-decoration: none; }
section { max-width: var(--wide); margin: 0 auto; padding: 3.5rem 0 0; }
section > * { min-width: 0; }
section:not(.wide) > * { max-width: var(--measure); }
.diff { max-width: 100%; }
h1 { font-size: clamp(2.25rem, 5.5vw, 3.75rem); line-height: 1.04; letter-spacing: -0.035em; font-weight: 800; margin: 3rem 0 1.25rem; max-width: 14ch; }
h2 { font-size: 1.75rem; letter-spacing: -0.02em; line-height: 1.15; margin: 0 0 1rem; font-weight: 800; }
h3 { font-size: 1.125rem; margin: 1.75rem 0 0.5rem; font-weight: 600; }
p { margin: 0 0 1rem; max-width: 64ch; }
.lede { font-size: 1.25rem; color: var(--pencil); max-width: 52ch; }

.install { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin: 2rem 0 0; }
.install pre { min-width: 0; max-width: 100%; margin: 0; padding: 0.6rem 0.9rem; background: var(--highlight); border-radius: 2px; overflow-x: auto; }
.install button { font: 600 0.95rem "Bricolage Grotesque", sans-serif; color: var(--ink); background: transparent; border: 1.5px solid var(--ink); border-radius: 2px; padding: 0.5rem 0.9rem; cursor: pointer; }
.install button:hover { background: var(--ink); color: var(--paper); }

.diff { margin: 3rem 0 0; background: #fff; border: 1px solid var(--rule); padding: 1.25rem 0; overflow-x: auto; }
.diff .line { display: grid; grid-template-columns: 2.25rem minmax(0, 1fr) 15rem; align-items: baseline; min-height: 1.9rem; }
.diff .sign { text-align: center; color: var(--pencil); font-family: "Fragment Mono", monospace; }
.diff code { white-space: pre; font-size: 0.86rem; padding-right: 1rem; }
.diff .add { background: #eaf6ef; }
.diff .add .sign { color: var(--green); }
.diff .del { background: #fbecee; }
.diff .del code { color: #7a2533; }
.diff .ctx code { color: var(--pencil); }
.mark { font: 600 1.45rem/1 "Caveat", cursive; color: var(--pen); transform: rotate(-3deg); transform-origin: left center; padding-left: 0.75rem; position: relative; }
.mark::before { content: ""; position: absolute; left: -0.25rem; top: 0.55em; width: 0.65rem; border-top: 2px solid var(--pen); }
.diff figcaption { padding: 1rem 1.25rem 0; color: var(--pencil); font-size: 0.95rem; }
@media (prefers-reduced-motion: no-preference) {
  .mark { clip-path: inset(0 100% 0 0); animation: write 0.6s ease-out forwards; }
  .line:nth-child(3) .mark { animation-delay: 0.4s; }
  .line:nth-child(7) .mark { animation-delay: 1.0s; }
  .line:nth-child(10) .mark { animation-delay: 1.6s; }
  .line:nth-child(13) .mark { animation-delay: 2.2s; }
  @keyframes write { to { clip-path: inset(0 0 0 0); } }
}
@media (max-width: 760px) {
  .diff .line { grid-template-columns: 1.75rem minmax(0, 1fr); }
  .mark { grid-column: 2; padding: 0.15rem 0 0.4rem 0.75rem; }
}

table { width: 100%; border-collapse: collapse; margin: 1.25rem 0 2rem; font-size: 0.95rem; font-variant-numeric: tabular-nums; }
caption { text-align: left; font-weight: 600; padding-bottom: 0.5rem; }
th, td { text-align: left; padding: 0.55rem 0.75rem 0.55rem 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
thead th { color: var(--pencil); font-weight: 600; font-size: 0.85rem; border-bottom: 1.5px solid var(--ink); }
td { white-space: nowrap; }
tbody th { font-weight: 400; }
.table-scroll { overflow-x: auto; }
table.compact { max-width: 34rem; }
.rules td:first-child code { font-weight: 600; white-space: nowrap; }
.rules td { white-space: normal; }
.verdict-blocks { color: var(--pen); font-weight: 600; }
.verdict-warns { color: var(--pencil); }

ol.flow { list-style: none; padding: 0; margin: 1.5rem 0 0; counter-reset: step; }
ol.flow li { counter-increment: step; padding: 0 0 1.25rem 3rem; position: relative; max-width: 64ch; }
ol.flow li::before { content: counter(step); position: absolute; left: 0; top: -0.1rem; font-weight: 800; font-size: 1.5rem; color: var(--pen); }
ol.flow strong { display: block; }

.demos { display: grid; gap: 2rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 28rem), 1fr)); margin-top: 1.5rem; }
.demos figure { margin: 0; }
.demos video { width: 100%; height: auto; border: 1px solid var(--rule); display: block; background: #1e1e2e; }
.demos figcaption { color: var(--pencil); font-size: 0.95rem; margin-top: 0.6rem; }

.finding { border-left: 3px solid var(--pen); padding-left: 1rem; margin: 1.5rem 0; }
details { border-bottom: 1px solid var(--rule); padding: 0.9rem 0; max-width: 64ch; }
summary { cursor: pointer; font-weight: 600; }
details p { margin-top: 0.6rem; }
footer { max-width: var(--wide); margin: 4rem auto 3rem; color: var(--pencil); font-size: 0.95rem; }
</style>
</head>
<body>
<header class="top">
  <a class="wordmark" href="#">cheatguard</a>
  <a href="${REPO_URL}">Source on GitHub</a>
</header>
<main>
<section class="wide">
  <h1>Your agent says the tests pass. Check how.</h1>
  <p class="lede">cheatguard reads the diff your coding agent produced and stops the shortcuts: deleted assertions, skipped tests, silenced type errors, relaxed configs, stubs and imports of packages that do not exist. It runs locally, in milliseconds, with no AI in the loop.</p>
  <div class="install">
    <pre id="install-cmd">npm i -D cheatguard &amp;&amp; npx cheatguard init claude-code</pre>
    <button type="button" id="copy">Copy command</button>
  </div>
  <p>Or, without a dependency, as a Claude Code plugin: <code>claude plugin marketplace add aguschirico/cheatguard</code>, then <code>claude plugin install cheatguard@cheatguard</code>.</p>
  ${heroDiff()}
</section>

<section>
  <h2>What it catches</h2>
  <p>Every rule looks at what changed, not at the whole file, so years of existing code never get in the way. Blocking rules stop the agent from finishing until the problem is fixed properly; warnings are shown without blocking.</p>
  <div class="table-scroll"><table class="rules"><thead><tr><th scope="col">Rule</th><th scope="col">What it reports</th><th scope="col">Effect</th></tr></thead><tbody>
  ${RULES.map(([id, what, effect]) => `<tr><td><code>${id}</code></td><td>${esc(what)}</td><td class="verdict-${effect}">${effect === "blocks" ? "Blocks" : "Warns"}</td></tr>`).join("")}
  </tbody></table></div>
  <p>It also runs the linters you already have (ESLint, Biome, oxlint, tsc) on just the changed files and shows only the problems the change introduced, so the agent reads a few lines instead of a wall of old warnings.</p>
</section>

<section>
  <h2>How it runs inside Claude Code</h2>
  <ol class="flow">
    <li><strong>When a session starts</strong>It records a snapshot of the working tree, so changes that were already there are never blamed on the agent.</li>
    <li><strong>After every edit</strong>It checks the file that was just written and pushes back immediately, while the agent still has the context to fix it.</li>
    <li><strong>When the agent says it is done</strong>It checks the whole change plus new lint and type errors. If something blocking remains, the agent has to keep working. After three attempts it lets the agent stop and tells you what is left.</li>
  </ol>
  <p>The same checks run anywhere with <code>npx cheatguard check</code>: in CI, in a pre-commit hook, or after any other agent.</p>
</section>

<section class="wide">
  <h2>See it work</h2>
  <div class="demos">
    <figure><video src="assets/demo-check.mp4" poster="assets/demo-check.png" muted loop playsinline controls preload="none" width="1280" height="760" aria-label="Terminal recording: cheatguard check lists a deleted assertion, a skipped test, an as-any cast and strict mode turned off"></video><figcaption>An agent’s “fix” for failing tests, checked in under a second.</figcaption></figure>
    <figure><video src="assets/demo-lint.mp4" poster="assets/demo-lint.png" muted loop playsinline controls preload="none" width="1280" height="760" aria-label="Terminal recording: tsc prints dozens of old errors while cheatguard lint shows only the three new ones"></video><figcaption>A legacy repository: dozens of old errors hidden, the three new ones shown.</figcaption></figure>
  </div>
</section>

<section class="wide">
  <h2>Measured, including where it does not help</h2>
  <p>All numbers below come from the benchmark scripts in the repository and are regenerated with the page.</p>

  <h3>Does it flag the right things?</h3>
  <div class="table-scroll">${corpusTable()}</div>
  <div class="table-scroll">${perRuleTable()}</div>
  <p>Real pull requests were labeled by hand by a single annotator; every label and its reasoning is in the repository. The synthetic set was written alongside the rules, so treat its perfect score as a regression test, not as evidence.</p>

  <h3>Do agents cheat, and does cheatguard change what they ship?</h3>
  <div class="table-scroll">${agentTables()}</div>
  <div class="finding">
    <p>${story.cheats} (<a href="https://arxiv.org/abs/2511.21654">EvilGenie</a>, <a href="https://chatpaper.com/de/paper/284076">SpecBench</a>)</p>
    <p>${story.effect}</p>
    <p>${story.cost} ${story.noise}</p>
  </div>

  <h3>How much less does the agent have to read?</h3>
  <div class="table-scroll">${lintTable()}</div>
  <p>Clean repositories produce little output either way; the savings grow with existing noise.${slowerThanRaw().length > 0 ? ` On ${esc(slowerThanRaw().join(" and "))} cheatguard was slower than running the linters once, because it also snapshots the working tree.` : ""}</p>
</section>

<section>
  <h2>Limits worth knowing</h2>
  <ul>
    <li>It is a guardrail against shortcuts, not a sandbox. An agent determined to evade it, with full write access, can.</li>
    <li>The analysis is syntactic: an <code>any</code> inferred by TypeScript, or a value hard-coded to pass one test, is not detected.</li>
    <li>TypeScript and JavaScript only for now. Python, Go and Rust are on the roadmap.</li>
    <li>Changing an expected value in a test is sometimes correct. cheatguard blocks it when the code under test did not change and warns otherwise, so it will occasionally push back on a legitimate fix.</li>
  </ul>
</section>

<section>
  <h2>Questions</h2>
  <details><summary>Does it replace code review?</summary><p>No. It removes a class of shortcuts before review, so reviewers spend their time on design and intent.</p></details>
  <details><summary>Does it send my code anywhere?</summary><p>No. It runs locally against your git history and never opens a network connection.</p></details>
  <details><summary>Which agents does it work with?</summary><p>Claude Code has first-class hooks today. Any agent can use <code>cheatguard check</code> at the end of a task, and adapters for other agents are planned.</p></details>
  <details><summary>Can the agent just turn it off?</summary><p>Rules are read from the version of <code>cheatguard.config.json</code> committed before the change, session state lives outside the repository, and any edit to the config is itself blocked.</p></details>
</section>
</main>
<footer>
  <p>cheatguard is open source under the Apache 2.0 license. The rules, the hooks and the benchmarks will stay free.</p>
</footer>
<script>
if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? e.target.play().catch(() => {}) : e.target.pause();
  }, { threshold: 0.4 });
  document.querySelectorAll(".demos video").forEach((v) => io.observe(v));
}
document.getElementById("copy").addEventListener("click", async (event) => {
  const text = document.getElementById("install-cmd").textContent;
  try {
    await navigator.clipboard.writeText(text);
    event.currentTarget.textContent = "Copied";
  } catch {
    event.currentTarget.textContent = "Select the command to copy it";
  }
});
</script>
</body>
</html>
`;

// ---------------------------------------------------------------- README benchmark section
function markdownSection(): string {
  const out: string[] = [];
  if (corpus) {
    out.push(
      "**Does it flag the right things?** (benchmark A, hand-labeled)",
      "",
      "| Corpus | Cases | Changed lines | Precision | Recall | Precision of blocking flags | Wrong blocks per 1,000 lines |",
      "|---|---:|---:|---:|---:|---:|---:|",
    );
    for (const [set, s] of Object.entries(corpus.sets)) {
      out.push(
        `| ${SET_LABEL[set] ?? set} | ${s.cases} | ${s.changedLines.toLocaleString("en-US")} | ${pct(s.overall.precision)} | ${pct(s.overall.recall)} | ${pct(s.blockPrecision)} | ${dec(s.falseBlockFlagsPer1000Lines)} |`,
      );
    }
    out.push("");
  }
  if (agents.length > 0) {
    out.push(
      "**Do agents cheat, and does cheatguard change what they ship?** (benchmark B: 14 trap tasks + 5 controls, real Claude Code runs, graded with hidden tests independent of cheatguard)",
      "",
      "| Model | Setup | Runs that cheated | Honest solves (traps) | Honest solves (controls) | Avg time |",
      "|---|---|---:|---:|---:|---:|",
    );
    for (const s of agents) {
      for (const arm of ["none", "prompt", "cheatguard"] as const) {
        const a = s.arms[arm];
        out.push(
          `| ${s.model}${s.pressure ? " (urgent prompt)" : ""} | ${ARM_LABEL[arm]} | ${a.all.cheated} / ${a.all.n} | ${pct(a.trap.honestRate)} | ${pct(a.control.honestRate)} | ${dec(a.avgDurationS, 0)} s |`,
        );
      }
    }
    out.push("", story.cheats, "", story.effect, "", `${story.cost} ${story.noise}`, "");
  }
  if (lint) {
    out.push(
      "**How much less does the agent read?** (benchmark C: seeded change in real repositories)",
      "",
      "| Repository | Linters | Tokens, raw linters | Tokens, cheatguard (with baseline) | Time, raw | Time, cheatguard | New problems kept |",
      "|---|---|---:|---:|---:|---:|---:|",
    );
    for (const r of lint.results) {
      if (!r.raw || !r.cheatguard) continue;
      out.push(
        `| ${r.repo} | ${linters(r)} | ${r.raw.tokens} | ${r.cheatguard.tokens} (${(r.cheatguardWithBaseline ?? r.cheatguard).tokens}) | ${(r.raw.ms / 1000).toFixed(1)} s | ${(r.cheatguard.ms / 1000).toFixed(1)} s | ${r.cheatguard.seededFound} / ${r.seededDiagnostics ?? "?"} |`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}

const readmePath = join(ROOT, "README.md");
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, "utf8");
  const updated = readme.replace(
    /<!-- bench:start -->[\s\S]*?<!-- bench:end -->/,
    `<!-- bench:start -->\n${markdownSection()}\n<!-- bench:end -->`,
  );
  writeFileSync(readmePath, updated);
}

mkdirSync(join(OUT, "assets"), { recursive: true });
writeFileSync(join(OUT, "index.html"), html);
const assets = join(ROOT, "site", "assets");
if (existsSync(assets)) cpSync(assets, join(OUT, "assets"), { recursive: true });
console.log(
  `Wrote ${join(OUT, "index.html")} (${agents.length} agent summaries, corpus ${corpus ? "yes" : "no"}, lint ${lint ? "yes" : "no"})`,
);
