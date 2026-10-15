export type Severity = "block" | "warn";

export const RULE_IDS = [
  "test-weakened",
  "type-suppression",
  "config-tampering",
  "stub-left",
  "phantom-import",
  "swallowed-error",
  "duplicate-export",
  "scope-creep",
  "parse-error",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export const LINT_TOOLS = ["eslint", "biome", "tsc"] as const;

export type LintToolName = (typeof LINT_TOOLS)[number];

export interface Violation {
  rule: RuleId;
  severity: Severity;
  /** POSIX path relative to the repository root. */
  file: string;
  /** 1-based line in the "after" version of the file (0 when not applicable). */
  line: number;
  /** What changed, in one sentence. */
  detail: string;
  /** What the agent should do instead. */
  fix: string;
}

export interface CheatguardConfig {
  rules: Partial<Record<RuleId, Severity | "off">>;
  scope: { allow: string[] };
  tests: { patterns: string[] };
  ignore: string[];
  lint: {
    tools: LintToolName[] | "auto";
    onEdit: LintToolName[];
    onStop: LintToolName[];
    maxDiagnostics: number;
    blockOnStop: boolean;
  };
  hooks: {
    /** Blocked Stops in a row before the agent is let go (the issues are shown to the user). */
    maxStopBlocks: number;
    /** Show new warnings to the agent once at Stop (they are otherwise only shown to the user). */
    warnAgentOnStop: boolean;
    /** How long Stop waits for the session's lint baseline to finish recording. */
    baselineWaitSeconds: number;
  };
}
