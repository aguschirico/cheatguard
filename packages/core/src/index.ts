export const VERSION = "0.1.0";

export { collectChanges, computeAddedLines, type FileChange, readTextAt } from "./changes.js";
export { loadConfigAt } from "./config/at.js";
export {
  CONFIG_FILE,
  ConfigError,
  configFromText,
  configJsonSchema,
  DEFAULT_CONFIG,
  loadConfig,
  parseConfig,
} from "./config/index.js";
export {
  type CheckFileOptions,
  type CheckOptions,
  type CheckResult,
  check,
  checkFile,
  filterIgnored,
  type HeadSpec,
  RULES,
  runRules,
} from "./engine.js";
export {
  changedPaths,
  GitError,
  headCommit,
  NotAGitRepoError,
  repoRoot,
  resolveTree,
  type SnapshotOptions,
  STATE_DIR,
  snapshotWorkingTree,
  sparseEntries,
} from "./git/index.js";
export {
  detectTools,
  type LintBaseline,
  type MissingTool,
  planTools,
  runLint,
  selectNew,
  snapshotLintBaseline,
  snapshotLintBaselineAt,
  type ToolPlan,
} from "./lint/index.js";
export { parseBiomeGithub, parseEslintJson, parseTscOutput } from "./lint/parsers.js";
export type { Diagnostic, LintResult, ToolRun } from "./lint/types.js";
export { createProjectContext, diskSource, memorySource, treeSource } from "./project.js";
export { canonicalPath } from "./realpath.js";
export {
  formatHook,
  formatJson,
  formatPretty,
  type HookFormatOptions,
  type Report,
  type Summary,
  summarize,
  type ToolProblem,
} from "./report/index.js";
export type { Rule } from "./rules/types.js";
export {
  clearRelease,
  type Intervention,
  type LintStatus,
  lintStatus,
  loadLintBaseline,
  loadRelease,
  loadSession,
  logError,
  logIntervention,
  markLintPending,
  newSession,
  type Release,
  readInterventions,
  type SessionState,
  type StartOptions,
  saveLintBaseline,
  saveRelease,
  saveSession,
  startSession,
  stateDir,
} from "./session.js";
export {
  type CheatguardConfig,
  LINT_TOOLS,
  type LintToolName,
  RULE_IDS,
  type RuleId,
  type Severity,
  type Violation,
} from "./types.js";
