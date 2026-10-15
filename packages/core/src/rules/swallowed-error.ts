import type { CatchKind } from "../lang/adapter.js";
import type { Violation } from "../types.js";
import { newItems } from "./diffing.js";
import type { Rule } from "./types.js";

const SWALLOWING = new Set<CatchKind>(["empty", "comment-only", "log-only"]);
const LABELS: Record<CatchKind, string> = {
  empty: "empty error handler",
  "comment-only": "error handler with only a comment",
  "log-only": "error handler that only logs",
  handled: "error handler",
};

export const swallowedError: Rule = {
  id: "swallowed-error",
  scope: "file",
  defaultSeverity: "warn",
  description: "New catch blocks that swallow errors (empty, comment-only, or console-only).",
  check(ctx) {
    const violations: Violation[] = [];
    for (const change of ctx.changes) {
      const after = change.afterFacts;
      if (!after || change.parseError) continue;
      const swallowing = (kind: CatchKind): boolean => SWALLOWING.has(kind);
      const added = newItems(
        (change.beforeFacts?.catches ?? []).filter((c) => swallowing(c.kind)),
        after.catches.filter((c) => swallowing(c.kind)),
        (c) => c.text,
        () => "swallow",
      );
      for (const c of added) {
        violations.push({
          rule: "swallowed-error",
          severity: "warn",
          file: change.path,
          line: c.line,
          detail: `New ${LABELS[c.kind]}`,
          fix: "Handle the error (recover, rethrow with context, or return an explicit failure) instead of hiding it.",
        });
      }
    }
    return violations;
  },
};
