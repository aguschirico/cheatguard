import type { LintToolName } from "../types.js";

export interface Diagnostic {
  tool: LintToolName;
  /** POSIX path relative to the repository root. */
  file: string;
  line: number;
  column: number;
  /** Rule name (ESLint/Biome) or TS error code ("TS2322"). */
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface ToolRun {
  tool: LintToolName;
  ok: boolean;
  /** Set when the tool could not run or its output could not be parsed. */
  error?: string;
  durationMs: number;
  /** Size of the raw tool output the agent would otherwise read. */
  rawChars: number;
  /** Diagnostics reported by the tool before filtering. */
  total: number;
}

export interface LintResult {
  tools: ToolRun[];
  /** Diagnostics introduced by the change (sorted, uncapped). */
  newDiagnostics: Diagnostic[];
  /** Diagnostics hidden because they existed before the change. */
  preexisting: number;
  /** Without a baseline: diagnostics in files the change did not touch (could not be attributed). */
  outsideChange: number;
  rawChars: number;
  durationMs: number;
}
