import picomatch from "picomatch";
import { collectChanges, computeAddedLines, type FileChange, readTextAt } from "./changes.js";
import { indexTree, resolveTree, snapshotWorkingTree } from "./git/index.js";
import { createProjectContext, diskSource, type ProjectContext, treeSource } from "./project.js";
import { adapterFor, analyzeChange, createRuleContext, testMatcher } from "./rules/analyze.js";
import { configKindOf } from "./rules/config-files.js";
import { configTampering } from "./rules/config-tampering.js";
import { duplicateExport } from "./rules/duplicate-export.js";
import { phantomImport } from "./rules/phantom-import.js";
import { scopeCreep } from "./rules/scope-creep.js";
import { stubLeft } from "./rules/stub-left.js";
import { swallowedError } from "./rules/swallowed-error.js";
import { testWeakened } from "./rules/test-weakened.js";
import { typeSuppression } from "./rules/type-suppression.js";
import type { Rule } from "./rules/types.js";
import type { CheatguardConfig, Violation } from "./types.js";

export const RULES: readonly Rule[] = [
  testWeakened,
  typeSuppression,
  configTampering,
  stubLeft,
  phantomImport,
  swallowedError,
  duplicateExport,
  scopeCreep,
];

export type RuleScope = "file" | "project";

export interface RunRulesInput {
  changes: readonly FileChange[];
  project: ProjectContext;
  config: CheatguardConfig;
  scopes?: readonly RuleScope[];
}

export interface CheckResult {
  violations: Violation[];
  /** Changed files that were analyzed (after ignore filtering). */
  filesAnalyzed: number;
  /** Changes that were skipped because they are binary or too large. */
  skipped: Array<{ path: string; reason: "binary" | "too-large" }>;
  /** Changes considered, after ignore filtering (used by the lint stage). */
  changes: readonly FileChange[];
  durationMs: number;
}

const SEVERITY_ORDER = { block: 0, warn: 1 } as const;

function sortViolations(violations: Violation[]): Violation[] {
  return violations.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.rule.localeCompare(b.rule),
  );
}

export function filterIgnored(
  changes: readonly FileChange[],
  config: CheatguardConfig,
): FileChange[] {
  const ignored = picomatch(config.ignore, { dot: true });
  // Config files are never ignorable: ignoring them would let anyone relax the gates unseen.
  return changes.filter((c) => configKindOf(c.path) !== null || !ignored(c.path));
}

/** Runs the rules over already-collected changes. Pure apart from reading project files. */
export function runRules(input: RunRulesInput): CheckResult {
  const start = performance.now();
  const scopes = new Set<RuleScope>(input.scopes ?? ["file", "project"]);
  const changes = filterIgnored(input.changes, input.config);
  const isTest = testMatcher(input.config);
  const analyzed = changes.map((c) => analyzeChange(c, isTest));
  const ctx = createRuleContext(analyzed, input.project, input.config);
  const violations: Violation[] = [];
  for (const change of analyzed) {
    const gated = change.isTest || configKindOf(change.path) !== null;
    if (change.skipReason === "too-large" && (adapterFor(change.path) || gated)) {
      violations.push({
        rule: "parse-error",
        severity: gated || change.status !== "added" ? "block" : "warn",
        file: change.path,
        line: 0,
        detail: "File is too large to analyze (over 1 MB), so its changes cannot be verified",
        fix: "Keep source, test and config files under 1 MB; split the file instead of growing it.",
      });
    }
    if (change.parseError) {
      violations.push({
        rule: "parse-error",
        severity: "warn",
        file: change.path,
        line: change.parseError.line,
        detail: `File does not parse (${change.parseError.message}); AST rules were skipped for it`,
        fix: "Fix the syntax error so the change can be checked.",
      });
    }
  }
  for (const rule of RULES) {
    if (!scopes.has(rule.scope)) continue;
    violations.push(...rule.check(ctx));
  }
  const final: Violation[] = [];
  const seen = new Set<string>();
  for (const v of violations) {
    const setting = input.config.rules[v.rule];
    if (setting === "off") continue;
    const adjusted = setting ? { ...v, severity: setting } : v;
    const key = `${adjusted.rule}\0${adjusted.file}\0${adjusted.line}\0${adjusted.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    final.push(adjusted);
  }
  return {
    violations: sortViolations(final),
    filesAnalyzed: analyzed.filter((c) => c.supported || configKindOf(c.path) !== null).length,
    skipped: analyzed.flatMap((c) =>
      c.skipReason ? [{ path: c.path, reason: c.skipReason }] : [],
    ),
    changes,
    durationMs: performance.now() - start,
  };
}

export type HeadSpec = "worktree" | "index" | { tree: string };

export interface CheckOptions {
  root: string;
  /** A git ref (e.g. "HEAD", "origin/main") or { tree } for a recorded baseline. */
  base: string | { tree: string };
  head: HeadSpec;
  config: CheatguardConfig;
  scopes?: readonly RuleScope[];
  /** Restrict to changes under these repo-relative paths (files or directories). */
  paths?: readonly string[];
  /** Sparse-checkout paths recorded when the session started (see snapshotWorkingTree). */
  sparse?: ReadonlySet<string>;
}

function resolveHead(root: string, head: HeadSpec, sparse?: ReadonlySet<string>): string {
  if (head === "worktree") return snapshotWorkingTree(root, sparse ? { sparse } : {});
  if (head === "index") return indexTree(root);
  return head.tree;
}

function underPaths(path: string, paths: readonly string[]): boolean {
  return paths.some((p) => {
    const clean = p.replace(/^\.\//, "").replace(/\/$/, "");
    return clean === "" || clean === "." || path === clean || path.startsWith(`${clean}/`);
  });
}

/** Full check: diff two git trees and run every rule. */
export function check(options: CheckOptions): CheckResult {
  const baseTree =
    typeof options.base === "string" ? resolveTree(options.root, options.base) : options.base.tree;
  const headTree = resolveHead(options.root, options.head, options.sparse);
  let changes = collectChanges(options.root, baseTree, headTree);
  if (options.paths && options.paths.length > 0) {
    const paths = options.paths;
    changes = changes.filter(
      (c) => underPaths(c.path, paths) || (c.oldPath !== undefined && underPaths(c.oldPath, paths)),
    );
  }
  const project = createProjectContext(options.root, treeSource(options.root, headTree));
  const input: RunRulesInput = { changes, project, config: options.config };
  if (options.scopes) input.scopes = options.scopes;
  return runRules(input);
}

export interface CheckFileOptions {
  root: string;
  baseTree: string;
  /** Repo-relative POSIX path of the file that was just edited. */
  path: string;
  config: CheatguardConfig;
}

/** Fast path for edit hooks: one file on disk vs. the baseline tree, file-scope rules only. */
export function checkFile(options: CheckFileOptions): CheckResult {
  const source = diskSource(options.root);
  const before = readTextAt(options.root, options.baseTree, options.path);
  const afterText = source.read(options.path);
  // Any JSON file can be a tsconfig reached through "extends".
  const relevant =
    adapterFor(options.path) !== undefined ||
    configKindOf(options.path) !== null ||
    /\.jsonc?$/.test(options.path);
  if (!relevant || (before.text === null && afterText === null && !before.skip)) {
    return { violations: [], filesAnalyzed: 0, skipped: [], changes: [], durationMs: 0 };
  }
  const tooLarge = afterText !== null && Buffer.byteLength(afterText) > 1024 * 1024;
  const skipReason = before.skip ?? (tooLarge ? "too-large" : null);
  const change: FileChange = {
    path: options.path,
    status:
      before.text === null && !before.skip ? "added" : afterText === null ? "deleted" : "modified",
    before: skipReason ? null : before.text,
    after: skipReason ? null : afterText,
    addedLines:
      skipReason || afterText === null ? new Set() : computeAddedLines(before.text, afterText),
    skipReason,
  };
  if (change.before === change.after && !skipReason) {
    return { violations: [], filesAnalyzed: 0, skipped: [], changes: [], durationMs: 0 };
  }
  return runRules({
    changes: [change],
    project: createProjectContext(options.root, source),
    config: options.config,
    scopes: ["file"],
  });
}
