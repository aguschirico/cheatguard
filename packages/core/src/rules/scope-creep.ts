import picomatch from "picomatch";
import type { Rule } from "./types.js";

export const scopeCreep: Rule = {
  id: "scope-creep",
  scope: "project",
  defaultSeverity: "warn",
  description: "Files changed outside the configured scope.allow globs.",
  check(ctx) {
    if (ctx.config.scope.allow.length === 0) return [];
    const allowed = picomatch(ctx.config.scope.allow, { dot: true });
    return ctx.changes
      .filter((c) => !allowed(c.path) || (c.oldPath !== undefined && !allowed(c.oldPath)))
      .map((c) => ({
        rule: "scope-creep" as const,
        severity: "warn" as const,
        file: c.path,
        line: 0,
        detail: `${c.oldPath && !allowed(c.oldPath) ? `${c.oldPath} (moved to ${c.path})` : c.path} was ${c.status} outside the allowed scope (${ctx.config.scope.allow.join(", ")})`,
        fix: "Revert changes outside the task's scope, or confirm with the user that they are needed.",
      }));
  },
};
