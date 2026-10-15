import picomatch from "picomatch";
import type { FunctionInfo } from "../lang/adapter.js";
import type { Violation } from "../types.js";
import { adapterFor, testMatcher } from "./analyze.js";
import type { Rule, RuleContext } from "./types.js";

const SIMILARITY_THRESHOLD = 0.85;
const MIN_BODY_TOKENS = 20;
const MAX_PROJECT_FILES = 5000;
const SUFFIX_RE = /(new|copy|alt|impl|helper|fn|v\d+|\d+)+$/;

export function normalizeFunctionName(name: string): string {
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const stripped = flat.replace(SUFFIX_RE, "");
  return stripped.length >= 3 ? stripped : flat;
}

function shingles(tokens: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + 2 < tokens.length; i += 1)
    set.add(`${tokens[i]}\0${tokens[i + 1]}\0${tokens[i + 2]}`);
  return set;
}

/** Jaccard similarity of token 3-shingles. */
export function similarity(a: readonly string[], b: readonly string[]): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 && sb.size === 0) return a.join(" ") === b.join(" ") ? 1 : 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

interface Candidate {
  file: string;
  fn: FunctionInfo;
}

function projectExports(ctx: RuleContext): Candidate[] {
  const isTest = testMatcher(ctx.config);
  const ignored = picomatch(ctx.config.ignore, { dot: true });
  const candidates: Candidate[] = [];
  const files = ctx.project.source
    .list()
    .filter((f) => adapterFor(f) && !isTest(f) && !ignored(f))
    .slice(0, MAX_PROJECT_FILES);
  for (const file of files) {
    for (const fn of ctx.factsOf(file)?.functions ?? [])
      if (fn.exported) candidates.push({ file, fn });
  }
  return candidates;
}

export const duplicateExport: Rule = {
  id: "duplicate-export",
  scope: "project",
  defaultSeverity: "warn",
  description:
    "New exported functions that duplicate an existing export (near-identical name or body).",
  check(ctx) {
    const violations: Violation[] = [];
    const fresh: Candidate[] = [];
    for (const change of ctx.changes) {
      if (!change.afterFacts || change.parseError || change.isTest) continue;
      const existing = new Set(
        (change.beforeFacts?.functions ?? []).filter((f) => f.exported).map((f) => f.name),
      );
      for (const fn of change.afterFacts.functions) {
        if (fn.exported && !existing.has(fn.name)) fresh.push({ file: change.path, fn });
      }
    }
    if (fresh.length === 0) return [];
    const candidates = projectExports(ctx);
    for (const { file, fn } of fresh) {
      const normalized = normalizeFunctionName(fn.name);
      for (const other of candidates) {
        if (other.file === file && other.fn.name === fn.name) continue;
        if (fresh.some((f) => f.file === other.file && f.fn.name === other.fn.name)) continue;
        const sameNormalizedName =
          other.fn.name !== fn.name && normalizeFunctionName(other.fn.name) === normalized;
        const longEnough =
          fn.tokens.length >= MIN_BODY_TOKENS && other.fn.tokens.length >= MIN_BODY_TOKENS;
        const similarBody =
          longEnough && similarity(fn.tokens, other.fn.tokens) >= SIMILARITY_THRESHOLD;
        if (!sameNormalizedName && !similarBody) continue;
        violations.push({
          rule: "duplicate-export",
          severity: "warn",
          file,
          line: fn.line,
          detail: `New export "${fn.name}" duplicates "${other.fn.name}" in ${other.file}${similarBody ? " (near-identical body)" : ""}`,
          fix: `Reuse "${other.fn.name}" from ${other.file} (extend it if needed) instead of adding a parallel implementation.`,
        });
        break;
      }
    }
    return violations;
  },
};
