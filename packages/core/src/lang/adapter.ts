/**
 * How a test was turned off or altered: skipped, focused, left as todo, inverted (`.fails`),
 * made conditional (`.skipIf`/`.runIf` with a non-constant condition), or run over an empty table.
 */
export type TestModifier = "skip" | "only" | "todo" | "fails" | "skipIf" | "runIf" | "empty-table";

export interface Assertion {
  line: number;
  /** Source text of the value under test (whitespace-normalized). */
  actual: string;
  /** Matcher chain, e.g. "toBe", "not.toEqual", "assert.equal". */
  matcher: string;
  /** Source text of the expected value(s), or null when the matcher takes none. */
  expected: string | null;
  /** True when the assertion only runs under a runtime condition (if, loop, ternary, catch...). */
  conditional: boolean;
  /** True when both sides are literals (`expect(4).toBe(4)`): it checks nothing. */
  vacuous: boolean;
}

export interface TestCase {
  /** Stable identity: describe names and the test name joined with " > ". */
  id: string;
  line: number;
  modifier: TestModifier | null;
  assertions: Assertion[];
}

export type SuppressionKind =
  | "any"
  | "as-any"
  | "as-unknown-as"
  | "as-never"
  | "function-type"
  | "untyped-module"
  | "coverage-ignore"
  | "ts-ignore"
  | "ts-expect-error"
  | "ts-nocheck"
  | "eslint-disable"
  | "oxlint-disable"
  | "biome-ignore";

export interface Suppression {
  kind: SuppressionKind;
  line: number;
  /** Normalized text of the line, used to tell moved suppressions from new ones. */
  text: string;
}

export interface ImportRef {
  specifier: string;
  line: number;
  typeOnly: boolean;
  /** Local binding names introduced by an ES import (default, named, namespace). */
  names: string[];
}

export type CatchKind = "empty" | "comment-only" | "log-only" | "handled";

export interface CatchInfo {
  line: number;
  kind: CatchKind;
  /** Normalized source of the handler, used to match catches across versions. */
  text: string;
}

export type BodyKind = "normal" | "empty" | "literal-return" | "throw-not-implemented";

export interface FunctionInfo {
  name: string;
  line: number;
  exported: boolean;
  /** Statements in the body, counted recursively (an expression body counts as one). */
  statementCount: number;
  bodyKind: BodyKind;
  /** Normalized body tokens, for similarity comparisons. */
  tokens: string[];
}

export interface NotImplementedThrow {
  line: number;
  text: string;
}

export interface TodoComment {
  line: number;
  text: string;
  /** True when the comment says the code is missing ("implement", "placeholder", "stub"...). */
  implement: boolean;
}

export type LiteralValue = string | number | boolean | null;

export interface LiteralEntry {
  /** Key path through object/array literals, e.g. "test.coverage.thresholds.lines" or "[0].rules.eqeqeq[1]". */
  path: string;
  value: LiteralValue;
  line: number;
}

export interface MockRef {
  /** Module specifier passed to vi.mock / jest.mock / vi.doMock. */
  specifier: string;
  line: number;
}

export interface FileFacts {
  tests: TestCase[];
  /** Modules replaced by the test framework's module mocks. */
  mocks: MockRef[];
  suppressions: Suppression[];
  imports: ImportRef[];
  /** Every name the module exports ("default" for default exports). */
  exports: string[];
  catches: CatchInfo[];
  functions: FunctionInfo[];
  notImplemented: NotImplementedThrow[];
  todos: TodoComment[];
  /** Only populated for config-like files (vitest/jest/eslint/... configs). */
  literals: LiteralEntry[];
}

export type AnalyzeResult =
  | { ok: true; facts: FileFacts }
  | { ok: false; line: number; message: string };

export interface LanguageAdapter {
  id: string;
  supports(path: string): boolean;
  analyze(path: string, text: string): AnalyzeResult;
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
