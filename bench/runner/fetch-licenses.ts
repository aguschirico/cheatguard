/**
 * Collects the license (and Apache NOTICE) of every repository the real-PR corpus quotes, so the
 * excerpts ship with the copyright and permission notices their licenses require.
 *
 *   node bench/runner/fetch-licenses.ts   (needs an authenticated `gh`)
 *
 * Writes bench/corpus/licenses/<owner>__<repo>.txt and bench/corpus/licenses/README.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The SPDX id GitHub detects for the license file, or null. */
function spdxOf(value: unknown): string | null {
  return isRecord(value) && isRecord(value.license) && typeof value.license.spdx_id === "string"
    ? value.license.spdx_id
    : null;
}

// A repository removed or relicensed since its cases were mined keeps the license its code was
// quoted under: the copy written by an earlier run.
const previous = new Map<string, string>();
// On the first run there is no directory yet; any other read error should stop the script.
if (existsSync(OUT)) {
  for (const file of readdirSync(OUT).filter((f) => f.endsWith(".txt")))
    previous.set(file, readFileSync(join(OUT, file), "utf8"));
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const rows: string[] = [];
const missing: string[] = [];
const kept: string[] = [];
for (const { repo, license } of sources()) {
  const name = `${repo.replace("/", "__")}.txt`;
  const response = ghJson(`repos/${repo}/license`);
  const text = spdxOf(response) === license ? decoded(response) : null;
  if (!text) {
    const earlier = previous.get(name);
    if (earlier === undefined) missing.push(repo);
    else {
      writeFileSync(join(OUT, name), earlier);
      rows.push(`| [${repo}](https://github.com/${repo}) | ${license} | [${name}](${name}) |`);
      kept.push(repo);
    }
    continue;
  }
  const notice = license === "Apache-2.0" ? decoded(ghJson(`repos/${repo}/contents/NOTICE`)) : null;
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
    ...(kept.length > 0
      ? [
          `Removed or relicensed since their cases were mined (the file is the license the code was quoted under, from an earlier run): ${kept.join(", ")}.`,
          "",
        ]
      : []),
    ...(missing.length > 0
      ? [
          `Not retrievable (repository renamed, removed or without a detectable license file): ${missing.join(", ")}. Their cases are listed in \`../NOTICE.md\`.`,
          "",
        ]
      : []),
  ].join("\n"),
);
console.log(
  `Wrote ${rows.length} license files${kept.length ? `; kept from an earlier run: ${kept.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}.`,
);
