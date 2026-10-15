import type { FileChange } from "../changes.js";
import type { FileFacts } from "../lang/adapter.js";
import type { ProjectContext } from "../project.js";
import type { CheatguardConfig, RuleId, Severity, Violation } from "../types.js";

export interface AnalyzedChange extends FileChange {
  /** True when the path (or, for renames, the old path) matches the test patterns. */
  isTest: boolean;
  /** True when the file still exists as a test the runner collects after the change. */
  afterIsTest: boolean;
  /** True when a language adapter understands this file. */
  supported: boolean;
  beforeFacts: FileFacts | null;
  afterFacts: FileFacts | null;
  /** Syntax error in the "after" version, if any (AST rules skip the file). */
  parseError: { line: number; message: string } | null;
}

export interface RuleContext {
  changes: readonly AnalyzedChange[];
  project: ProjectContext;
  config: CheatguardConfig;
  /** Facts of any project file in its "after" state (lazy, cached). */
  factsOf(path: string): FileFacts | null;
  /** Finds the change for a path (after-path or old path). */
  changeFor(path: string): AnalyzedChange | undefined;
}

export interface Rule {
  id: RuleId;
  /** "file" rules only need the changed files; "project" rules look at the whole project. */
  scope: "file" | "project";
  defaultSeverity: Severity;
  description: string;
  check(ctx: RuleContext): Violation[];
}
