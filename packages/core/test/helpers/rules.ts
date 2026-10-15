import { computeAddedLines, type FileChange } from "../../src/changes.js";
import { DEFAULT_CONFIG, parseConfig } from "../../src/config/index.js";
import { createProjectContext, memorySource } from "../../src/project.js";
import { analyzeChange, createRuleContext, testMatcher } from "../../src/rules/analyze.js";
import type { Rule, RuleContext } from "../../src/rules/types.js";
import type { Violation } from "../../src/types.js";

export interface ChangeSpec {
  path: string;
  before?: string | null;
  after?: string | null;
  oldPath?: string;
}

export interface ContextOptions {
  /** Unchanged files that exist in the project (after state). */
  files?: Record<string, string>;
  config?: unknown;
}

export function makeChange(spec: ChangeSpec): FileChange {
  const before = spec.before ?? null;
  const after = spec.after ?? null;
  const status =
    before === null ? "added" : after === null ? "deleted" : spec.oldPath ? "renamed" : "modified";
  const change: FileChange = {
    path: spec.path,
    status,
    before,
    after,
    addedLines: after === null ? new Set() : computeAddedLines(before, after),
    skipReason: null,
  };
  if (spec.oldPath) change.oldPath = spec.oldPath;
  return change;
}

export function contextFor(specs: ChangeSpec[], options: ContextOptions = {}): RuleContext {
  const config = options.config === undefined ? DEFAULT_CONFIG : parseConfig(options.config);
  const files: Record<string, string> = { ...options.files };
  for (const spec of specs) if (spec.after != null) files[spec.path] = spec.after;
  const project = createProjectContext("/repo", memorySource(files));
  const isTest = testMatcher(config);
  return createRuleContext(
    specs.map((s) => analyzeChange(makeChange(s), isTest)),
    project,
    config,
  );
}

export function run(rule: Rule, specs: ChangeSpec[], options: ContextOptions = {}): Violation[] {
  return rule.check(contextFor(specs, options));
}
