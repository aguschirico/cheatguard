import type { SuppressionKind } from "../lang/adapter.js";
import type { Violation } from "../types.js";
import { newItems, similarText } from "./diffing.js";
import type { Rule } from "./types.js";

const LABELS: Record<SuppressionKind, string> = {
  any: "explicit `any` type",
  "as-any": "`as any` cast",
  "as-unknown-as": "double cast through `unknown`",
  "as-never": "`as never` cast",
  "function-type": "`Function` type (accepts any callable, returns any)",
  "untyped-module": "untyped module declaration (every import from it is `any`)",
  "coverage-ignore": "coverage-ignore comment",
  "ts-ignore": "`@ts-ignore` directive",
  "ts-expect-error": "`@ts-expect-error` directive",
  "ts-nocheck": "`@ts-nocheck` directive",
  "eslint-disable": "`eslint-disable` directive",
  "oxlint-disable": "`oxlint-disable` directive",
  "biome-ignore": "`biome-ignore` directive",
};

const FIXES: Record<SuppressionKind, string> = {
  any: "Replace `any` with a precise type (or `unknown` plus narrowing).",
  "as-any": "Remove the cast and fix the type mismatch at its source.",
  "as-unknown-as": "Remove the double cast and make the types actually line up.",
  "as-never":
    "Remove the cast: `never` is assignable to everything, so it silences the type checker like `any`.",
  "function-type": "Use a precise function type, e.g. `(value: string) => void`.",
  "untyped-module": "Install the package's types or declare the exports you use with real types.",
  "coverage-ignore": "Remove the comment and add tests for the code it excludes from coverage.",
  "ts-ignore": "Remove the directive and fix the type error it hides.",
  "ts-expect-error": "Remove the directive and fix the type error it hides.",
  "ts-nocheck": "Remove `@ts-nocheck` and fix the file's type errors.",
  "eslint-disable": "Remove the directive and fix the lint error.",
  "oxlint-disable": "Remove the directive and fix the lint error.",
  "biome-ignore": "Remove the directive and fix the lint error.",
};

const BLOCK_IN_TESTS = new Set<SuppressionKind>(["ts-ignore", "ts-nocheck"]);

export const typeSuppression: Rule = {
  id: "type-suppression",
  scope: "file",
  defaultSeverity: "block",
  description: "New `any`, unsafe casts, or comments that silence the type checker or linter.",
  check(ctx) {
    const violations: Violation[] = [];
    for (const change of ctx.changes) {
      if (!change.afterFacts || change.parseError) continue;
      const added = newItems(
        change.beforeFacts?.suppressions ?? [],
        change.afterFacts.suppressions,
        (s) => `${s.kind}\0${s.text}`,
        (s) => s.kind,
        (a, b) => similarText(a.text, b.text),
      );
      for (const s of added) {
        violations.push({
          rule: "type-suppression",
          // Casts and `any` are common in test doubles; keep them visible without blocking. Directives
          // that switch the type checker off for a test still block.
          severity: change.isTest && !BLOCK_IN_TESTS.has(s.kind) ? "warn" : "block",
          file: change.path,
          line: s.line,
          detail: `New ${LABELS[s.kind]}: ${s.text}`,
          fix: FIXES[s.kind],
        });
      }
    }
    return violations;
  },
};
