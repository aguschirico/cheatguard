/**
 * Mines real pull requests into corpus cases (unlabeled).
 *
 *   node bench/runner/mine.ts --set agent --limit 60
 *   node bench/runner/mine.ts --set human --limit 60
 *
 * Only permissively licensed repositories are used; every case records its source URL and license.
 */
import { execFileSync } from "node:child_process";
import * as fsModule from "node:fs";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { parseArgs } from "node:util";
import { createProjectContext, memorySource } from "@cheatguard/core";
import { z } from "zod";
import {
  type CaseChange,
  type CorpusCase,
  corpusSetOption,
  readCase,
  writeCase,
} from "./corpus-lib.ts";

const { values } = parseArgs({
  options: {
    set: { type: "string", default: "agent" },
    limit: { type: "string", default: "40" },
    "max-lines": { type: "string", default: "500" },
    refresh: { type: "boolean", default: false },
    "fill-imports": { type: "boolean", default: false },
  },
});
const SET = corpusSetOption(values.set);
const LIMIT = Number(values.limit);
const MAX_LINES = Number(values["max-lines"]);
const ROOT = join(import.meta.dirname, "..", "corpus");

const PERMISSIVE = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
]);
const CODE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const CONFIG_RE =
  /(^|\/)(package\.json|tsconfig[\w.-]*\.json|\.eslintrc(\.json)?|eslint\.config\.[cm]?[jt]s|biome\.jsonc?|(vitest|vite|jest)(\.[\w-]+)*\.config\.[cm]?[jt]s)$/;
const SKIP_RE =
  /(^|\/)(node_modules|dist|build|vendor|\.next|coverage)\/|\.min\.js$|\.d\.ts$|(^|\/)(pnpm-lock|package-lock)\.|\.generated\./;

const MONTHS = ["2025-09", "2025-11", "2026-01", "2026-03", "2026-05", "2026-07", "2026-09"];
const AGENT_QUERIES = [
  ...MONTHS.map((m) => [
    '"Generated with Claude Code"',
    "language:typescript",
    "is:merged",
    `merged:${m}-01..${m}-28`,
  ]),
  ...MONTHS.map((m) => [
    "author:app/copilot-swe-agent",
    "language:typescript",
    "is:merged",
    `merged:${m}-01..${m}-28`,
  ]),
  ['"Generated with Claude Code"', "language:typescript", "is:merged"],
  ['"Generated with Claude Code"', "language:javascript", "is:merged"],
  ["author:app/copilot-swe-agent", "language:typescript", "is:merged"],
  ["author:app/devin-ai-integration", "language:typescript", "is:merged"],
  // Version 3: more agents. Codex cloud tasks open PRs from `codex/` branches under the user's name.
  ...MONTHS.slice(-4).flatMap((m) => [
    ["author:app/cursor", "language:typescript", "is:merged", `merged:${m}-01..${m}-28`],
    ["author:app/google-labs-jules", "language:typescript", "is:merged", `merged:${m}-01..${m}-28`],
    ["head:codex/", "language:typescript", "is:merged", `merged:${m}-01..${m}-28`],
  ]),
  ["author:app/devin-ai-integration", "language:javascript", "is:merged"],
  ["author:app/copilot-swe-agent", "language:javascript", "is:merged"],
];
const HUMAN_REPOS = [
  "vercel/swr",
  "react-hook-form/react-hook-form",
  "statelyai/xstate",
  "axios/axios",
  "pmndrs/react-spring",
  "typeorm/typeorm",
  "remix-run/react-router",
  "chakra-ui/chakra-ui",
  "facebook/docusaurus",
  "prisma/prisma",
  "colinhacks/zod",
  "date-fns/date-fns",
  "TanStack/query",
  "trpc/trpc",
  "pmndrs/zustand",
  "immerjs/immer",
  "sindresorhus/ky",
  "jaredpalmer/formik",
  "vitest-dev/vitest",
  "excalidraw/excalidraw",
  "pmndrs/jotai",
  "unjs/ofetch",
  // Version 3: more repositories.
  "reduxjs/redux-toolkit",
  "mobxjs/mobx",
  "apollographql/apollo-client",
  "graphql/graphql-js",
  "nestjs/nest",
  "vuejs/core",
  "sindresorhus/got",
  "mswjs/msw",
  "testing-library/react-testing-library",
  "pmndrs/valtio",
  "moment/luxon",
  "puppeteer/puppeteer",
  "typescript-eslint/typescript-eslint",
  "vitejs/vite",
  "mikro-orm/mikro-orm",
  "knex/knex",
  "preactjs/preact",
  "solidjs/solid",
  "socketio/socket.io",
  "yargs/yargs",
  "unjs/h3",
  "fastify/fastify",
];

function gh(args: string[], accept?: string): string {
  const full = accept ? ["api", "-H", `Accept: ${accept}`, ...args] : args;
  return execFileSync("gh", full, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** GitHub API call whose response is validated against `schema` (no unchecked casts). */
function api<S extends z.ZodType>(path: string, schema: S): z.infer<S> {
  return schema.parse(JSON.parse(gh(["api", path])));
}

const shaRef = z.object({ sha: z.string() });
const treeSchema = z.object({
  tree: z.array(z.object({ path: z.string(), type: z.string() })),
  truncated: z.boolean().optional(),
});

function raw(repo: string, path: string, ref: string): string | null {
  try {
    return gh(
      [`repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`],
      "application/vnd.github.raw",
    );
  } catch {
    return null;
  }
}

const searchHit = z.object({
  number: z.number(),
  url: z.string(),
  repository: z.object({ nameWithOwner: z.string() }),
  author: z.object({ login: z.string() }).optional(),
});
type SearchHit = z.infer<typeof searchHit>;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Search API calls are throttled hard (secondary rate limits): pace them and back off on 403. */
function search(terms: string[], limit: number): SearchHit[] {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    sleep(attempt === 0 ? 7_000 : 65_000);
    try {
      return z
        .array(searchHit)
        .parse(
          JSON.parse(
            gh([
              "search",
              "prs",
              ...terms,
              "--limit",
              String(limit),
              "--json",
              "number,url,repository,author",
            ]),
          ),
        );
    } catch (error) {
      const text = String(error);
      if (!/rate limit|403/i.test(text)) {
        console.error(`search failed for ${terms.join(" ")}: ${text.slice(0, 200)}`);
        return [];
      }
    }
  }
  console.error(`search gave up after retries: ${terms.join(" ")}`);
  return [];
}

const licenseCache = new Map<string, string | null>();
function licenseOf(repo: string): string | null {
  if (!licenseCache.has(repo)) {
    try {
      const info = api(
        `repos/${repo}`,
        z.object({
          license: z.object({ spdx_id: z.string().nullable().optional() }).nullable(),
          private: z.boolean(),
          fork: z.boolean(),
        }),
      );
      licenseCache.set(repo, info.private ? null : (info.license?.spdx_id ?? null));
    } catch {
      licenseCache.set(repo, null);
    }
  }
  return licenseCache.get(repo) ?? null;
}

const prFile = z.object({
  filename: z.string(),
  status: z.string(),
  previous_filename: z.string().optional(),
  additions: z.number(),
  deletions: z.number(),
});

function slug(repo: string, n: number): string {
  return `${repo.replace("/", "__")}__${n}`.toLowerCase();
}

function mine(hit: SearchHit): CorpusCase | null {
  const repo = hit.repository.nameWithOwner;
  const id = slug(repo, hit.number);
  if (existsSync(join(ROOT, SET, `${id}.json`))) return null;
  const license = licenseOf(repo);
  if (!license || !PERMISSIVE.has(license)) return null;
  const pr = api(
    `repos/${repo}/pulls/${hit.number}`,
    z.object({
      base: shaRef,
      head: shaRef,
      merged_at: z.string().nullable(),
      user: z.object({ login: z.string() }),
    }),
  );
  const files = api(`repos/${repo}/pulls/${hit.number}/files?per_page=100`, z.array(prFile));
  const relevant = files.filter(
    (f) => (CODE_RE.test(f.filename) || CONFIG_RE.test(f.filename)) && !SKIP_RE.test(f.filename),
  );
  const code = relevant.filter((f) => CODE_RE.test(f.filename));
  const lines = relevant.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (code.length === 0 || relevant.length > 10 || lines > MAX_LINES || lines < 3) return null;
  const compare = api(
    `repos/${repo}/compare/${pr.base.sha}...${pr.head.sha}`,
    z.object({ merge_base_commit: shaRef }),
  );
  const before = compare.merge_base_commit.sha;
  const after = pr.head.sha;
  const changes: CaseChange[] = [];
  for (const f of relevant) {
    const oldPath = f.previous_filename ?? f.filename;
    const beforeText = f.status === "added" ? null : raw(repo, oldPath, before);
    const afterText = f.status === "removed" ? null : raw(repo, f.filename, after);
    if (beforeText === null && afterText === null) continue;
    if ((beforeText?.length ?? 0) > 400_000 || (afterText?.length ?? 0) > 400_000) return null;
    const change: CaseChange = { path: f.filename, before: beforeText, after: afterText };
    if (f.status === "renamed" && f.previous_filename) change.oldPath = f.previous_filename;
    changes.push(change);
  }
  if (changes.length === 0) return null;
  // Context: every path in the tree (existence only), plus the manifests that drive resolution.
  const tree = api(`repos/${repo}/git/trees/${after}?recursive=1`, treeSchema);
  const context: Record<string, string> = {};
  const changed = new Set(changes.map((c) => c.path));
  for (const entry of tree.tree) {
    if (entry.type === "blob" && !changed.has(entry.path) && !entry.path.includes("node_modules/"))
      context[entry.path] = "";
  }
  const tsconfigs = Object.keys(context)
    .filter((p) => /(^|\/)[tj]sconfig[\w.-]*\.json$/.test(p))
    .slice(0, 25);
  for (const p of tsconfigs) {
    const text = raw(repo, p, after);
    if (text !== null) context[p] = text;
  }
  const manifests = new Set([
    "package.json",
    "tsconfig.json",
    "tsconfig.base.json",
    "pnpm-workspace.yaml",
  ]);
  for (const c of changes) {
    let dir = posix.dirname(c.path);
    while (dir !== "." && dir !== "") {
      manifests.add(`${dir}/package.json`);
      manifests.add(`${dir}/tsconfig.json`);
      dir = posix.dirname(dir);
    }
  }
  for (const m of manifests) {
    if (changed.has(m) || !(m in context || m === "pnpm-workspace.yaml")) continue;
    const text = raw(repo, m, after);
    if (text !== null) context[m] = text;
  }
  // Workspace package names (monorepos) so workspace imports resolve.
  const pkgs = Object.keys(context)
    .filter((p) => p.endsWith("/package.json") && !manifests.has(p))
    .slice(0, 40);
  for (const p of pkgs) {
    const text = raw(repo, p, after);
    if (text !== null) context[p] = text;
  }
  return {
    id,
    set: SET,
    description: `${repo}#${hit.number}`,
    source: { url: hit.url, repo, license, author: pr.user.login, mergedAt: pr.merged_at ?? "" },
    changes,
    context,
    expected: [],
    notes: "UNLABELED",
  };
}

/** Re-fetches context (full tree listing + every tsconfig) for cases mined with an older miner. */
function refresh(): void {
  const { readdirSync, writeFileSync } = require_fs();
  const dir = join(ROOT, SET);
  for (const file of readdirSync(dir).filter((f: string) => f.endsWith(".json"))) {
    const c = readCase(join(dir, file));
    if (!c.source) continue;
    const n = Number(c.source.url.split("/").pop());
    try {
      const pr = api(`repos/${c.source.repo}/pulls/${n}`, z.object({ head: shaRef }));
      const tree = api(`repos/${c.source.repo}/git/trees/${pr.head.sha}?recursive=1`, treeSchema);
      const changed = new Set(c.changes.map((ch) => ch.path));
      for (const entry of tree.tree) {
        if (
          entry.type === "blob" &&
          !changed.has(entry.path) &&
          !entry.path.includes("node_modules/") &&
          !(entry.path in c.context)
        )
          c.context[entry.path] = "";
      }
      for (const p of Object.keys(c.context)
        .filter((x) => /(^|\/)[tj]sconfig[\w.-]*\.json$/.test(x) && c.context[x] === "")
        .slice(0, 25)) {
        const text = raw(c.source.repo, p, pr.head.sha);
        if (text !== null) c.context[p] = text;
      }
      writeFileSync(join(dir, file), `${JSON.stringify(c, null, 2)}\n`);
      console.log(`refreshed ${c.id}`);
    } catch (error) {
      console.log(`refresh failed ${c.id}: ${String(error).split("\n")[0]}`);
    }
  }
}

const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXTS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

/**
 * Fetches the content of unchanged modules imported (transitively, 3 levels) by changed test files:
 * relative imports, and bare ones that tsconfig paths map into the repository (a package's tests
 * often import it by its own name).
 */
function fillImports(): void {
  const { readdirSync, writeFileSync } = require_fs();
  const dir = join(ROOT, SET);
  for (const file of readdirSync(dir).filter((f: string) => f.endsWith(".json"))) {
    const c = readCase(join(dir, file));
    if (!c.source) continue;
    const tests = c.changes.filter((ch) => /test|spec/.test(ch.path) && (ch.after ?? ch.before));
    if (tests.length === 0) continue;
    let head: string;
    try {
      head = api(
        `repos/${c.source.repo}/pulls/${Number(c.source.url.split("/").pop())}`,
        z.object({ head: shaRef }),
      ).head.sha;
    } catch {
      continue;
    }
    const files: Record<string, string> = { ...c.context };
    for (const ch of c.changes) if (ch.after !== null) files[ch.path] = ch.after;
    const project = createProjectContext("/corpus", memorySource(files));
    let frontier = tests.map((t) => ({ path: t.path, text: t.after ?? t.before ?? "" }));
    let fetched = 0;
    for (let depth = 0; depth < 3 && frontier.length > 0 && fetched < 40; depth += 1) {
      const next: Array<{ path: string; text: string }> = [];
      for (const { path, text } of frontier) {
        for (const m of text.matchAll(IMPORT_RE)) {
          const spec = m[1] ?? m[2];
          if (!spec) continue;
          const base = posix.normalize(posix.join(posix.dirname(path), spec.replace(/\.js$/, "")));
          const target = spec.startsWith(".")
            ? EXTS.map((e) => `${base}${e}`).find((p) => p in c.context)
            : project.resolveAlias(spec);
          if (!target || !(target in c.context) || c.context[target] !== "" || fetched >= 40)
            continue;
          const content = raw(c.source.repo, target, head);
          fetched += 1;
          if (content === null || content.length > 300_000) continue;
          c.context[target] = content;
          next.push({ path: target, text: content });
        }
      }
      frontier = next;
    }
    writeFileSync(join(dir, file), `${JSON.stringify(c, null, 2)}\n`);
    if (fetched > 0) console.log(`${c.id}: fetched ${fetched} imported modules`);
  }
}

function require_fs(): typeof import("node:fs") {
  return fsModule;
}

function hits(): SearchHit[] {
  if (SET === "agent") {
    return AGENT_QUERIES.flatMap((q) => search(q, 60));
  }
  return HUMAN_REPOS.flatMap((repo) =>
    search([`repo:${repo}`, "is:merged", "merged:<2022-06-01", "sort:updated"], 25),
  );
}

if (values.refresh) {
  refresh();
  process.exit(0);
}
if (values["fill-imports"]) {
  fillImports();
  process.exit(0);
}
const MAX_PER_REPO = 3;
const perRepo = new Map<string, number>();
for (const f of (await import("node:fs")).readdirSync(join(ROOT, SET), { withFileTypes: true })) {
  const repo = f.name.split("__").slice(0, 2).join("/");
  perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
}
let written = 0;
const seen = new Set<string>();
const skipped: Array<{ pr: string; reason: string }> = [];
for (const hit of hits()) {
  if (written >= LIMIT) break;
  const key = `${hit.repository.nameWithOwner}#${hit.number}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const repoKey = hit.repository.nameWithOwner.toLowerCase();
  if ((perRepo.get(repoKey) ?? 0) >= MAX_PER_REPO) continue;
  try {
    const c = mine(hit);
    if (!c) continue;
    writeCase(ROOT, c);
    written += 1;
    perRepo.set(repoKey, (perRepo.get(repoKey) ?? 0) + 1);
    console.log(`[${written}/${LIMIT}] ${key} (${c.changes.length} files)`);
  } catch (error) {
    skipped.push({ pr: key, reason: String(error).split("\n")[0]?.slice(0, 160) ?? "unknown" });
  }
}
console.log(`Mined ${written} ${SET} cases; ${skipped.length} PRs failed to download:`);
for (const s of skipped) console.log(`  ${s.pr}: ${s.reason}`);
