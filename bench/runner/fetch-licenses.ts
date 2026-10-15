/**
 * Collects the license (and Apache NOTICE) of every repository the real-PR corpus quotes, so the
 * excerpts ship with the copyright and permission notices their licenses require.
 *
 *   node bench/runner/fetch-licenses.ts   (needs an authenticated `gh`)
 *
 * Writes bench/corpus/licenses/<owner>__<repo>.txt and bench/corpus/licenses/README.md.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CORPUS = join(import.meta.dirname, "..", "corpus");
const OUT = join(CORPUS, "licenses");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function ghJson(path: string): unknown {
  try {
    return JSON.parse(
      execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
    );
  } catch {
    return null;
  }
}

function decoded(value: unknown): string | null {
  if (!isRecord(value) || typeof value.content !== "string") return null;
  return Buffer.from(value.content, "base64").toString("utf8");
}

interface Source {
  repo: string;
  license: string;
}

function sources(): Source[] {
  const found = new Map<string, string>();
  for (const set of ["agent", "human"]) {
    for (const file of readdirSync(join(CORPUS, set)).filter((f) => f.endsWith(".json"))) {
      const parsed: unknown = JSON.parse(readFileSync(join(CORPUS, set, file), "utf8"));
      const source = isRecord(parsed) && isRecord(parsed.source) ? parsed.source : null;
      if (source && typeof source.repo === "string") {
        found.set(source.repo, typeof source.license === "string" ? source.license : "unknown");
      }
    }
  }
  return [...found]
    .map(([repo, license]) => ({ repo, license }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const rows: string[] = [];
const missing: string[] = [];
for (const { repo, license } of sources()) {
  const text = decoded(ghJson(`repos/${repo}/license`));
  if (!text) {
    missing.push(repo);
    continue;
  }
  const notice = license === "Apache-2.0" ? decoded(ghJson(`repos/${repo}/contents/NOTICE`)) : null;
  const name = `${repo.replace("/", "__")}.txt`;
  const parts = [`Source: https://github.com/${repo}`, `License: ${license}`, "", text.trim()];
  if (notice) parts.push("", "---- NOTICE ----", "", notice.trim());
  writeFileSync(join(OUT, name), `${parts.join("\n")}\n`);
  rows.push(`| [${repo}](https://github.com/${repo}) | ${license} | [${name}](${name}) |`);
}
writeFileSync(
  join(OUT, "README.md"),
  [
    "# Licenses of the quoted repositories",
    "",
    "The real-PR cases under `../agent` and `../human` quote files from these repositories. Each file below holds the repository's license text (with its copyright notice) and, for Apache-2.0 projects, its NOTICE file, as published on the default branch when this list was generated (`node bench/runner/fetch-licenses.ts`).",
    "",
    "| Repository | License | Notice |",
    "|---|---|---|",
    ...rows,
    "",
    ...(missing.length > 0
      ? [
          `Not retrievable (repository renamed, removed or without a detectable license file): ${missing.join(", ")}. Their cases are listed in \`../NOTICE.md\`.`,
          "",
        ]
      : []),
  ].join("\n"),
);
console.log(
  `Wrote ${rows.length} license files${missing.length ? `; missing: ${missing.join(", ")}` : ""}.`,
);
