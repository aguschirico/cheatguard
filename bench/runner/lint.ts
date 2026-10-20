/**
 * Benchmark C: what an agent reads after an edit — raw linter output vs `cheatguard lint`.
 *
 *   node bench/runner/lint.ts
 *
 * For each repository: shallow clone (pinned ref), install with scripts disabled, record a lint
 * baseline, apply a seeded edit that introduces lint and type errors, then measure the size (≈ tokens),
 * wall time and content of (a) running the project's linters directly and (b) cheatguard lint
 * without and with a baseline. Recall = seeded diagnostics that each output still contains.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  parseBiomeGithub,
  parseEslintJson,
  parseOxlintJson,
  parseTscOutput,
} from "@cheatguard/core";
import { z } from "zod";

const BENCH = join(import.meta.dirname, "..");
// Outside this repository: a clone inside our pnpm workspace would be installed as part of it.
const WORK = process.env.CHEATGUARD_BENCH_WORK ?? join(tmpdir(), "cheatguard-bench-lint");
const CLI = join(BENCH, "..", "packages", "cli", "dist", "bin.js");

interface Repo {
  name: string;
  url: string;
  ref: string;
  /** File that receives the seeded edit (relative to the repo). */
  seedFile: string;
  /** Commands an agent would typically run to lint/typecheck the project. */
  raw: string[][];
  tools: Array<"eslint" | "biome" | "oxlint" | "tsc">;
  /** JavaScript seed (no type annotations). */
  js?: boolean;
}

const REPOS: Repo[] = [
  {
    name: "zustand",
    url: "https://github.com/pmndrs/zustand.git",
    ref: "main",
    seedFile: "src/vanilla.ts",
    raw: [
      ["npx", "eslint", "."],
      ["npx", "tsc", "--noEmit", "-p", "."],
    ],
    tools: ["eslint", "tsc"],
  },
  {
    name: "ofetch",
    url: "https://github.com/unjs/ofetch.git",
    ref: "main",
    seedFile: "src/utils.ts",
    raw: [
      ["npx", "eslint", "."],
      ["npx", "tsc", "--noEmit", "-p", "."],
    ],
    tools: ["eslint", "tsc"],
  },
  {
    name: "jotai",
    url: "https://github.com/pmndrs/jotai.git",
    ref: "main",
    seedFile: "src/vanilla/atom.ts",
    raw: [
      ["npx", "eslint", "."],
      ["npx", "tsc", "--noEmit", "-p", "."],
    ],
    tools: ["eslint", "tsc"],
  },
  {
    name: "axios",
    url: "https://github.com/axios/axios.git",
    ref: "v1.x",
    seedFile: "lib/helpers/combineURLs.js",
    raw: [["npx", "eslint", "."]],
    tools: ["eslint"],
    js: true,
  },
  {
    name: "vue-test-utils",
    url: "https://github.com/vuejs/test-utils.git",
    ref: "main",
    seedFile: "src/utils.ts",
    raw: [
      ["npx", "oxlint"],
      ["npx", "tsc", "--noEmit", "-p", "."],
    ],
    tools: ["oxlint", "tsc"],
  },
  {
    name: "update-electron-app",
    url: "https://github.com/electron/update-electron-app.git",
    ref: "main",
    seedFile: "src/index.ts",
    raw: [
      ["npx", "oxlint"],
      ["npx", "tsc", "--noEmit", "-p", "."],
    ],
    tools: ["oxlint", "tsc"],
  },
  {
    name: "unstorage",
    url: "https://github.com/unjs/unstorage.git",
    ref: "main",
    seedFile: "src/utils.ts",
    raw: [
      ["npx", "oxlint", "."],
      ["npx", "tsc", "--noEmit", "--skipLibCheck"],
    ],
    tools: ["oxlint", "tsc"],
  },
  {
    name: "consola",
    url: "https://github.com/unjs/consola.git",
    ref: "main",
    seedFile: "src/utils/string.ts",
    raw: [
      ["npx", "eslint", "."],
      ["npx", "tsc", "--noEmit", "-p", "."],
    ],
    tools: ["eslint", "tsc"],
  },
  {
    name: "tanstack-form",
    url: "https://github.com/TanStack/form.git",
    ref: "main",
    seedFile: "packages/form-core/src/utils.ts",
    raw: [
      ["npx", "eslint", "packages/form-core"],
      ["npx", "tsc", "--noEmit", "-p", "packages/form-core"],
    ],
    tools: ["eslint", "tsc"],
  },
  {
    name: "better-auth",
    url: "https://github.com/better-auth/better-auth.git",
    ref: "main",
    seedFile: "packages/core/src/utils/string.ts",
    raw: [
      ["npx", "biome", "lint", "."],
      ["npx", "tsc", "--build"],
    ],
    tools: ["biome", "tsc"],
  },
];

const JS_SEED = `
export function cheatguardSeed(input) {
  let unusedCounter = 0;
  const parsed = input == null ? 0 : Number(input);
  return parsed;
}
`;

const SEED = `
export function cheatguardSeed(input: string): number {
  let unusedCounter = 0;
  const parsed: number = input;
  return parsed;
}
`;

/**
 * oxlint and Biome configs often leave unused variables off or as warnings; \`debugger\` is an error
 * in oxlint's default correctness category and in Biome's recommended rules.
 */
const DEBUGGER_SEED = `
export function cheatguardSeed(input: string): number {
  let unusedCounter = 0;
  const parsed: number = input;
  debugger;
  return parsed;
}
`;

const seedFor = (repo: Repo): string =>
  repo.js
    ? JS_SEED
    : repo.tools.includes("oxlint") || repo.tools.includes("biome")
      ? DEBUGGER_SEED
      : SEED;

function sh(
  cwd: string,
  cmd: string,
  args: string[],
  timeoutMs = 600_000,
): { out: string; stdout: string; ms: number; status: number | null } {
  const start = performance.now();
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
  });
  return {
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    stdout: r.stdout ?? "",
    ms: performance.now() - start,
    status: r.status,
  };
}

function readPackageManager(dir: string): string {
  const pkg = z
    .object({ packageManager: z.string().optional() })
    .safeParse(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
  return pkg.success ? (pkg.data.packageManager ?? "") : "";
}

function prepare(repo: Repo): string {
  const dir = join(WORK, repo.name);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(WORK, { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--branch", repo.ref, repo.url, dir], {
      stdio: "ignore",
    });
  }
  execFileSync("git", ["checkout", "--", "."], { cwd: dir });
  execFileSync("git", ["clean", "-fdq", "-e", "node_modules"], { cwd: dir });
  if (!existsSync(join(dir, "node_modules"))) {
    const pnpm = existsSync(join(dir, "pnpm-lock.yaml"));
    // Monorepos need their workspace packages installed (and linked) for tsc and the linters.
    const workspace = existsSync(join(dir, "pnpm-workspace.yaml"));
    // Recent monorepos require the pnpm major they pin (engines, trust policies): run that version.
    const pinned = /^pnpm@(\d+\.\d+\.\d+)/.exec(readPackageManager(dir))?.[1];
    const [pnpmCmd, ...pnpmPrefix] = pinned ? ["npx", "--yes", `pnpm@${pinned}`] : ["pnpm"];
    let r = pnpm
      ? sh(dir, pnpmCmd ?? "pnpm", [
          ...pnpmPrefix,
          "install",
          ...(workspace ? [] : ["--ignore-workspace"]),
          "--ignore-scripts",
          "--config.manage-package-manager-versions=false",
          "--frozen-lockfile=false",
          "--config.confirmModulesPurge=false",
        ])
      : sh(dir, "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
    // Projects managed with yarn can carry peer conflicts npm refuses by default.
    if (r.status !== 0 && !pnpm && /ERESOLVE/.test(r.out)) {
      r = sh(dir, "npm", [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--legacy-peer-deps",
      ]);
    }
    if (r.status !== 0) throw new Error(`install failed for ${repo.name}: ${r.out.slice(-400)}`);
  }
  return dir;
}

const tokens = (chars: number): number => Math.round(chars / 4);

interface Measure {
  chars: number;
  tokens: number;
  ms: number;
  diagnostics: number;
  seededFound: number;
}

function seededLines(dir: string, file: string, seed: string): Set<number> {
  const lines = readFileSync(join(dir, file), "utf8").split("\n");
  const start = lines.findIndex((l) => l.includes("cheatguardSeed"));
  const length = seed.trim().split("\n").length;
  return new Set(Array.from({ length }, (_, i) => start + 1 + i));
}

function rawDiagnostics(repo: Repo, dir: string): Array<{ file: string; line: number }> {
  const out: Array<{ file: string; line: number }> = [];
  for (const tool of repo.tools) {
    if (tool === "eslint")
      out.push(
        ...parseEslintJson(
          sh(dir, "npx", ["eslint", "--format", "json", repo.seedFile]).stdout,
          dir,
        ),
      );
    if (tool === "biome")
      out.push(
        ...parseBiomeGithub(
          sh(dir, "npx", ["biome", "lint", "--reporter=github", repo.seedFile]).stdout,
          dir,
        ),
      );
    if (tool === "oxlint")
      out.push(
        ...parseOxlintJson(sh(dir, "npx", ["oxlint", "--format=json", repo.seedFile]).stdout, dir),
      );
    if (tool === "tsc") {
      // The project's own type-check command (monorepos point it at a package or use --build).
      const [, ...args] = repo.raw.find((c) => c[1] === "tsc") ?? ["npx", "tsc", "--noEmit"];
      out.push(...parseTscOutput(sh(dir, "npx", [...args, "--pretty", "false"]).stdout, dir));
    }
  }
  return out;
}

function measureRaw(repo: Repo, dir: string, seeded: Set<number>, truth: number): Measure {
  let chars = 0;
  let ms = 0;
  let text = "";
  for (const [cmd = "npx", ...args] of repo.raw) {
    const r = sh(dir, cmd, args);
    chars += r.out.length;
    ms += r.ms;
    text += r.out;
  }
  const diagnostics = (text.match(/\b(error|warning)\b/gi) ?? []).length;
  void seeded;
  return { chars, tokens: tokens(chars), ms, diagnostics, seededFound: truth };
}

function measureCheatguard(
  repo: Repo,
  dir: string,
  seeded: Set<number>,
  baseline: string | null,
): Measure {
  const args = [CLI, "lint", "--format", "json", ...(baseline ? ["--baseline", baseline] : [])];
  const text = sh(dir, process.execPath, args);
  const pretty = sh(dir, process.execPath, [
    CLI,
    "lint",
    ...(baseline ? ["--baseline", baseline] : []),
  ]);
  const parsed = z
    .object({
      lint: z
        .object({ newDiagnostics: z.array(z.object({ file: z.string(), line: z.number() })) })
        .optional(),
    })
    .parse(JSON.parse(text.stdout));
  const found = parsed.lint?.newDiagnostics ?? [];
  return {
    chars: pretty.out.length,
    tokens: tokens(pretty.out.length),
    ms: pretty.ms,
    diagnostics: found.length,
    seededFound: found.filter((d) => d.file === repo.seedFile && seeded.has(d.line)).length,
  };
}

const { values } = parseArgs({ options: { repos: { type: "string" } } });
const selected = values.repos
  ? REPOS.filter((r) => values.repos?.split(",").includes(r.name))
  : REPOS;
const results: Array<Record<string, unknown>> = [];
for (const repo of selected) {
  try {
    const dir = prepare(repo);
    const baselineFile = join(WORK, `${repo.name}.baseline.json`);
    sh(dir, process.execPath, [CLI, "lint", "--snapshot", baselineFile]);
    writeFileSync(
      join(dir, repo.seedFile),
      `${readFileSync(join(dir, repo.seedFile), "utf8")}${seedFor(repo)}`,
    );
    const seeded = seededLines(dir, repo.seedFile, seedFor(repo));
    const truth = rawDiagnostics(repo, dir).filter(
      (d) => d.file === repo.seedFile && seeded.has(d.line),
    ).length;
    const raw = measureRaw(repo, dir, seeded, truth);
    const noBaseline = measureCheatguard(repo, dir, seeded, null);
    const withBaseline = measureCheatguard(repo, dir, seeded, baselineFile);
    execFileSync("git", ["checkout", "--", "."], { cwd: dir });
    results.push({
      repo: repo.name,
      linters: repo.tools,
      seededDiagnostics: truth,
      raw,
      cheatguard: noBaseline,
      cheatguardWithBaseline: withBaseline,
    });
    console.log(
      `${repo.name}: raw ${raw.tokens} tokens / ${Math.round(raw.ms)} ms → cheatguard ${noBaseline.tokens} tokens / ${Math.round(noBaseline.ms)} ms (seeded ${noBaseline.seededFound}/${truth}), with baseline ${withBaseline.tokens} tokens (seeded ${withBaseline.seededFound}/${truth})`,
    );
  } catch (error) {
    results.push({ repo: repo.name, error: String(error).slice(0, 500) });
    console.log(`${repo.name}: ERROR ${String(error).slice(0, 300)}`);
  }
}
// A run limited with --repos keeps the other repositories' last results.
const latest = join(BENCH, "results", "lint-latest.json");
const previous = z
  .object({ results: z.array(z.object({ repo: z.string() }).loose()) })
  .safeParse(existsSync(latest) ? JSON.parse(readFileSync(latest, "utf8")) : null);
const fresh = new Set(results.map((r) => r.repo));
const kept = (values.repos && previous.success ? previous.data.results : [])
  .filter((r) => !fresh.has(r.repo))
  // Which linters a repository runs is its definition above, not a measurement.
  .map((r) => ({ linters: REPOS.find((repo) => repo.name === r.repo)?.tools, ...r }));
const order = (r: Record<string, unknown>): number =>
  REPOS.findIndex((repo) => repo.name === r.repo);
writeFileSync(
  latest,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), results: [...kept, ...results].sort((a, b) => order(a) - order(b)) }, null, 2)}\n`,
);
