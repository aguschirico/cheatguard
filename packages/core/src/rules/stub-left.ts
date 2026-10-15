import type { Violation } from "../types.js";
import { newItems } from "./diffing.js";
import type { Rule } from "./types.js";

const GUTTED_MIN_STATEMENTS = 3;
const GUTTED_KIND_LABEL = { "literal-return": "a literal return", empty: "an empty body" } as const;

export const stubLeft: Rule = {
  id: "stub-left",
  scope: "file",
  defaultSeverity: "block",
  description:
    "Placeholder code: not-implemented throws, TODO-implement comments, or function bodies gutted to a literal.",
  check(ctx) {
    const violations: Violation[] = [];
    for (const change of ctx.changes) {
      const after = change.afterFacts;
      if (!after || change.parseError) continue;
      const before = change.beforeFacts;
      const add = (
        line: number,
        detail: string,
        fix: string,
        severity: "block" | "warn" = "block",
      ): void => {
        violations.push({ rule: "stub-left", severity, file: change.path, line, detail, fix });
      };

      for (const t of newItems(
        before?.notImplemented ?? [],
        after.notImplemented,
        (n) => n.text,
        () => "throw",
      )) {
        add(
          t.line,
          `New not-implemented placeholder: ${t.text}`,
          "Implement the function instead of leaving a placeholder.",
        );
      }

      for (const todo of newItems(
        before?.todos ?? [],
        after.todos,
        (t) => t.text,
        (t) => (t.implement ? "impl" : "todo"),
      )) {
        if (todo.implement) {
          add(
            todo.line,
            `New placeholder comment: "${todo.text}"`,
            "Write the missing implementation now; do not leave it for later.",
          );
        } else {
          add(
            todo.line,
            `New TODO comment: "${todo.text}"`,
            "Resolve the TODO in this change or explain why it must wait.",
            "warn",
          );
        }
      }

      const beforeFns = new Map((before?.functions ?? []).map((f) => [f.name, f]));
      for (const fn of after.functions) {
        const was = beforeFns.get(fn.name);
        if (was?.bodyKind !== "normal" || was.statementCount < GUTTED_MIN_STATEMENTS) continue;
        if (fn.bodyKind !== "literal-return" && fn.bodyKind !== "empty") continue;
        add(
          fn.line,
          `Function "${fn.name}" went from ${was.statementCount} statements to ${GUTTED_KIND_LABEL[fn.bodyKind]}`,
          `Restore a real implementation of "${fn.name}"; returning a constant only makes callers and tests pass by accident.`,
        );
      }
    }
    return violations;
  },
};
