import picomatch from "picomatch";
import type { FileChange } from "../changes.js";
import type { FileFacts, LanguageAdapter } from "../lang/adapter.js";
import { typescriptAdapter } from "../lang/typescript/index.js";
import type { ProjectContext } from "../project.js";
import type { CheatguardConfig } from "../types.js";
import type { AnalyzedChange, RuleContext } from "./types.js";

export const ADAPTERS: readonly LanguageAdapter[] = [typescriptAdapter];

export function adapterFor(path: string): LanguageAdapter | undefined {
  return ADAPTERS.find((a) => a.supports(path));
}

const factsCache = new Map<string, FileFacts | null>();

/** Facts for a file version; cached by path + content. Returns null on parse failure. */
export function factsFor(path: string, text: string | null): FileFacts | null {
  if (text === null) return null;
  const adapter = adapterFor(path);
  if (!adapter) return null;
  const key = `${adapter.id}\0${path}\0${text.length}\0${text}`;
  if (factsCache.has(key)) return factsCache.get(key) ?? null;
  const result = adapter.analyze(path, text);
  const facts = result.ok ? result.facts : null;
  if (factsCache.size > 2000) factsCache.clear();
  factsCache.set(key, facts);
  return facts;
}

export function testMatcher(config: CheatguardConfig): (path: string) => boolean {
  return picomatch(config.tests.patterns, { dot: true });
}

export function analyzeChange(
  change: FileChange,
  isTest: (path: string) => boolean,
): AnalyzedChange {
  const adapter = change.skipReason ? undefined : adapterFor(change.path);
  const beforePath = change.oldPath ?? change.path;
  let parseError: AnalyzedChange["parseError"] = null;
  let afterFacts: FileFacts | null = null;
  if (adapter && change.after !== null) {
    const result = adapter.analyze(change.path, change.after);
    if (result.ok) afterFacts = result.facts;
    else parseError = { line: result.line, message: result.message };
  }
  // A renamed file is read with the adapter of its old name (a test renamed to .bak still had tests).
  const beforeAdapter = change.skipReason ? undefined : adapterFor(beforePath);
  return {
    ...change,
    isTest: isTest(change.path) || (change.oldPath !== undefined && isTest(change.oldPath)),
    afterIsTest: change.status !== "deleted" && isTest(change.path) && adapter !== undefined,
    supported: adapter !== undefined,
    beforeFacts: beforeAdapter ? factsFor(beforePath, change.before) : null,
    afterFacts,
    parseError,
  };
}

export function createRuleContext(
  changes: readonly AnalyzedChange[],
  project: ProjectContext,
  config: CheatguardConfig,
): RuleContext {
  const byPath = new Map<string, AnalyzedChange>();
  for (const change of changes) {
    byPath.set(change.path, change);
    if (change.oldPath) byPath.set(change.oldPath, change);
  }
  return {
    changes,
    project,
    config,
    changeFor: (path) => byPath.get(path),
    factsOf(path) {
      const change = byPath.get(path);
      if (change && change.path === path) return change.afterFacts;
      return factsFor(path, project.source.read(path));
    },
  };
}
