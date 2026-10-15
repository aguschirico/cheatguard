import { splitLines } from "../changes.js";
import type { LiteralEntry, LiteralValue } from "../lang/adapter.js";
import { parsePnpmWorkspace } from "../lint/projects.js";
import type { Severity, Violation } from "../types.js";
import { testMatcher } from "./analyze.js";
import { agentSettingsFindings } from "./config-agent.js";
import { ciFindings } from "./config-ci.js";
import { type ConfigKind, configEntries, configKindOf, parseJsonc } from "./config-files.js";
import { dirOf, filesLost, filesNotMatched, listSample } from "./config-scope.js";
import { neutralizedScript } from "./config-scripts.js";
import type { AnalyzedChange, Rule, RuleContext } from "./types.js";

const STRICT_FLAGS = [
  "strict",
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "noImplicitThis",
  "alwaysStrict",
  "useUnknownInCatchVariables",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "noImplicitOverride",
  "noPropertyAccessFromIndexSignature",
  "noUnusedLocals",
  "noUnusedParameters",
  "checkJs",
];
const GUARDED_SCRIPT_RE = /^(test|tests|lint|typecheck|type-check|types|check|verify|ci)(:.*)?$/;
const ESLINT_SEVERITY: Record<string, number> = { off: 0, warn: 1, error: 2 };
const BIOME_SEVERITY: Record<string, number> = { off: 0, info: 1, warn: 2, on: 3, error: 3 };

const TEST_LIKE_RE =
  /(^|[/._*-])(tests?|specs?|__tests__|__mocks__|mocks?|fixtures?|stories)([/._*-]|$)|\.d\.ts$/i;

type Finding = { severity: Severity; line: number; detail: string; fix: string };

/** Where a config file sits and which project files its globs can match. */
interface Scope {
  configPath: string;
  /** Listed lazily: only edits that change a glob list need the project's files. */
  files: () => readonly string[];
  /** Project files that match cheatguard's test patterns. */
  testFiles: () => readonly string[];
}

/**
 * A config file version as two views: `exact` keyed by indexed paths ("[1].rules.eqeqeq[0]"),
 * `loose` with array indexes collapsed ("[].rules.eqeqeq[]") for membership checks.
 */
interface ConfigView {
  exact: Map<string, LiteralEntry>;
  loose: Map<string, LiteralEntry[]>;
}

const EMPTY: ConfigView = { exact: new Map(), loose: new Map() };

function view(entries: readonly LiteralEntry[]): ConfigView {
  const exact = new Map<string, LiteralEntry>();
  const loose = new Map<string, LiteralEntry[]>();
  for (const e of entries) {
    exact.set(e.path, e); // last wins, like JSON.parse and JS object literals
    const key = e.path.replace(/\[\d+\]/g, "[]");
    loose.set(key, [...(loose.get(key) ?? []), e]);
  }
  return { exact, loose };
}

/** Sub-view under `prefix.` (embedded configs such as package.json "jest"). */
function scoped(v: ConfigView, prefix: string): ConfigView {
  const strip = <T>(map: Map<string, T>): Map<string, T> => {
    const out = new Map<string, T>();
    for (const [path, value] of map)
      if (path.startsWith(`${prefix}.`)) out.set(path.slice(prefix.length + 1), value);
    return out;
  };
  return { exact: strip(v.exact), loose: strip(v.loose) };
}

const values = (v: ConfigView, path: string): LiteralValue[] =>
  (v.loose.get(path) ?? []).map((e) => e.value);

function grown(before: ConfigView, after: ConfigView, pathRe: RegExp): LiteralEntry[] {
  const out: LiteralEntry[] = [];
  for (const [path, entries] of after.loose) {
    if (!pathRe.test(path)) continue;
    const old = new Set(values(before, path));
    for (const e of entries) if (!old.has(e.value)) out.push(e);
  }
  return out;
}

function shrunk(before: ConfigView, after: ConfigView, pathRe: RegExp): LiteralEntry[] {
  const out: LiteralEntry[] = [];
  for (const [path, entries] of before.loose) {
    if (!pathRe.test(path)) continue;
    const now = new Set(values(after, path));
    for (const e of entries) if (!now.has(e.value)) out.push(e);
  }
  return out;
}

const label = (path: string): string => path.replace(/\[\d+\]/g, "[]").replace(/\[\]$/, "");

const stringValues = (v: ConfigView, path: string): string[] =>
  values(v, path).filter((x): x is string => typeof x === "string");

/**
 * Glob lists that select files (test include, ESLint files, Biome includes): an edit is fine as long
 * as every project file the old patterns matched is still matched.
 */
function narrowedSets(
  before: ConfigView,
  after: ConfigView,
  pathRe: RegExp,
  scope: Scope,
  what: string,
): Finding[] {
  const findings: Finding[] = [];
  const keys = new Set([...before.loose.keys()].filter((k) => pathRe.test(k)));
  for (const key of keys) {
    const was = stringValues(before, key);
    const now = stringValues(after, key);
    if (was.length === 0 || was.every((p) => now.includes(p))) continue;
    if (now.length === 0) {
      findings.push({
        severity: "block",
        line: 1,
        detail: `${label(key)} was removed (it listed ${was.map((p) => `"${p}"`).join(", ")})`,
        fix: `Restore ${label(key)}; ${what} must keep covering the same files.`,
      });
      continue;
    }
    const lost = filesLost(scope.files(), scope.configPath, was, now);
    if (lost.length === 0) continue;
    findings.push({
      severity: "block",
      line: after.loose.get(key)?.[0]?.line ?? 1,
      detail: `${label(key)} no longer matches ${lost.length} file(s) it covered: ${listSample(lost)}`,
      fix: `Restore the previous patterns; ${what} must keep covering every file it covered before.`,
    });
  }
  return findings;
}

function extendsFindings(before: ConfigView, after: ConfigView): Finding[] {
  const now = new Set([...values(after, "extends"), ...values(after, "extends[]")]);
  return [...values(before, "extends"), ...values(before, "extends[]")]
    .filter((v) => !now.has(v))
    .map((v) => ({
      severity: "block" as const,
      line: 1,
      detail: `Extended config "${String(v)}" was removed from extends`,
      fix: "Restore the extended preset; dropping it silently disables its rules.",
    }));
}

function tsconfigFindings(before: ConfigView, after: ConfigView, fresh: boolean): Finding[] {
  const findings: Finding[] = [];
  for (const flag of STRICT_FLAGS) {
    const path = `compilerOptions.${flag}`;
    const was = before.exact.get(path);
    const now = after.exact.get(path);
    const turnedOff = was?.value === true && now?.value !== true;
    const explicitlyDisabled = now?.value === false && was?.value !== false;
    if (turnedOff || explicitlyDisabled) {
      findings.push({
        severity: "block",
        line: now?.line ?? 1,
        detail: `${path} was ${now ? "turned off" : "removed"}`,
        fix: `Restore "${flag}" (leave it enabled or inherited) and fix the type errors it reports.`,
      });
    }
  }
  if (fresh) return findings;
  const skip = after.exact.get("compilerOptions.skipLibCheck");
  if (skip?.value === true && before.exact.get("compilerOptions.skipLibCheck")?.value !== true) {
    findings.push({
      severity: "warn",
      line: skip.line,
      detail: "compilerOptions.skipLibCheck was enabled",
      fix: "Keep library type checking on unless the team decided otherwise.",
    });
  }
  findings.push(...extendsFindings(before, after));
  for (const e of grown(before, after, /^exclude\[\]$/)) {
    findings.push({
      severity: "block",
      line: e.line,
      detail: `"${String(e.value)}" was added to tsconfig exclude`,
      fix: "Fix the type errors in that file instead of excluding it from type checking.",
    });
  }
  for (const e of shrunk(before, after, /^(include|files)\[\]$/)) {
    findings.push({
      severity: "block",
      line: 1,
      detail: `"${String(e.value)}" was removed from tsconfig ${label(e.path)}`,
      fix: "Keep the type-checked file set; fix the errors instead of narrowing it.",
    });
  }
  return findings;
}

function severityRank(
  value: LiteralValue | undefined,
  table: Record<string, number>,
): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value in table) return table[value] ?? null;
  return null;
}

/** ESLint rule settings keyed by their full indexed path, so every config object/override is distinct. */
function eslintRules(v: ConfigView): Map<string, { rule: string; entry: LiteralEntry }> {
  const rules = new Map<string, { rule: string; entry: LiteralEntry }>();
  for (const [path, entry] of v.exact) {
    const match = /^(.*?)(?:^|\.)rules\.([^.[]+)(?:\[(\d+)\])?$/.exec(path);
    if (!match) continue;
    const [, scope = "", rule = "", index] = match;
    if (index !== undefined && index !== "0") continue; // rule options, not severity
    rules.set(`${scope}\u0000${rule}`, { rule, entry });
  }
  return rules;
}

function eslintFindings(
  before: ConfigView,
  after: ConfigView,
  fresh: boolean,
  scope: Scope,
): Finding[] {
  const findings: Finding[] = [];
  const was = eslintRules(before);
  const now = eslintRules(after);
  for (const [key, { rule, entry }] of now) {
    const nowRank = severityRank(entry.value, ESLINT_SEVERITY);
    const previous = was.get(key);
    const wasRank = severityRank(previous?.entry.value, ESLINT_SEVERITY);
    if (nowRank === null) continue;
    if (previous && wasRank !== null && nowRank < wasRank) {
      findings.push({
        severity: "block",
        line: entry.line,
        detail: `ESLint rule "${rule}" was weakened: ${String(previous.entry.value)} → ${String(entry.value)}`,
        fix: `Restore "${rule}" to ${String(previous.entry.value)} and fix the violations it reports.`,
      });
    } else if (!previous && nowRank === 0) {
      findings.push({
        severity: "block",
        line: entry.line,
        detail: `ESLint rule "${rule}" was turned off`,
        fix: `Remove the "off" override for "${rule}" and fix the violations it reports.`,
      });
    }
  }
  if (fresh) return findings;
  const strongest = (rule: string): number =>
    Math.max(
      -1,
      ...[...now.values()]
        .filter((n) => n.rule === rule)
        .map((n) => severityRank(n.entry.value, ESLINT_SEVERITY) ?? -1),
    );
  for (const [key, { rule, entry }] of was) {
    const rank = severityRank(entry.value, ESLINT_SEVERITY);
    // Index shifts (an object inserted before) move a rule without removing it.
    if (!now.has(key) && rank !== null && rank > 0 && strongest(rule) < rank) {
      findings.push({
        severity: "warn",
        line: 1,
        detail: `ESLint rule "${rule}" was removed from the config`,
        fix: `Restore "${rule}" unless the team decided to drop it.`,
      });
    }
  }
  findings.push(...extendsFindings(before, after));
  for (const e of grown(before, after, /(^|\.)(ignores|ignorePatterns)\[\]$/)) {
    findings.push({
      severity: "block",
      line: e.line,
      detail: `"${String(e.value)}" was added to ESLint ignores`,
      fix: "Fix the lint errors instead of ignoring the files.",
    });
  }
  findings.push(...narrowedSets(before, after, /(^|\.)files\[\]$/, scope, "ESLint"));
  return findings;
}

const BIOME_RULE_RE = /(?:^|\.)linter\.rules\.([^.]+)\.([^.]+?)(\.level)?$/;

function biomeFindings(
  before: ConfigView,
  after: ConfigView,
  fresh: boolean,
  scope: Scope,
): Finding[] {
  const findings: Finding[] = [];
  for (const [path, now] of after.exact) {
    if (!/(^|\.)(linter\.enabled|linter\.rules\.recommended|formatter\.enabled)$/.test(path))
      continue;
    if (now.value === false && before.exact.get(path)?.value !== false) {
      findings.push({
        severity: "block",
        line: now.line,
        detail: `Biome ${path} was disabled`,
        fix: `Restore ${path}: true and fix the reported issues.`,
      });
    }
  }
  for (const [path, now] of after.exact) {
    const match = BIOME_RULE_RE.exec(path);
    if (!match || match[2] === "recommended") continue;
    const nowRank = severityRank(now.value, BIOME_SEVERITY);
    const was = before.exact.get(path);
    const wasRank = severityRank(was?.value, BIOME_SEVERITY);
    const weakened = was && wasRank !== null && nowRank !== null && nowRank < wasRank;
    const newlyOff = !was && nowRank === 0;
    if (weakened || newlyOff) {
      findings.push({
        severity: "block",
        line: now.line,
        detail: `Biome rule ${match[1]}.${match[2]} was ${newlyOff ? "turned off" : `weakened: ${String(was?.value)} → ${String(now.value)}`}`,
        fix: "Restore the rule level and fix the violations it reports.",
      });
    }
  }
  if (fresh) return findings;
  const ignored = grown(before, after, /(^|\.)(files|linter)\.(ignore|includes)\[\]$/).filter(
    (e) => !e.path.includes("includes") || String(e.value).startsWith("!"),
  );
  for (const e of ignored) {
    findings.push({
      severity: "block",
      line: e.line,
      detail: `"${String(e.value)}" was excluded from Biome`,
      fix: "Fix the issues in those files instead of excluding them.",
    });
  }
  findings.push(
    ...narrowedSets(
      before,
      after,
      /(^|\.)(files|linter|formatter)\.(include|includes)\[\]$/,
      scope,
      "Biome",
    ),
  );
  return findings;
}

function thresholdFindings(before: ConfigView, after: ConfigView): Finding[] {
  const findings: Finding[] = [];
  for (const [path, was] of before.exact) {
    if (!/threshold/i.test(path) || typeof was.value !== "number") continue;
    const now = after.exact.get(path);
    if (!now || (typeof now.value === "number" && now.value < was.value)) {
      findings.push({
        severity: "block",
        line: now?.line ?? 1,
        detail: `Coverage threshold ${path} was ${now ? `lowered: ${was.value} → ${String(now.value)}` : "removed"}`,
        fix: "Restore the threshold and add tests to meet it.",
      });
    }
  }
  return findings;
}

/** Keeps only the entries that configure the test runner (vite configs mix in build/dev settings). */
function testScope(v: ConfigView, onlyUnderTest: boolean): ConfigView {
  if (!onlyUnderTest) return v;
  const keep = <T>(map: Map<string, T>): Map<string, T> =>
    new Map([...map].filter(([path]) => /(^|\.)test\./.test(path)));
  return { exact: keep(v.exact), loose: keep(v.loose) };
}

const INCLUDE_RE = /(^|\.)(include|testMatch|spec|specPattern)\[\]$/;

/** A new test config (which may take precedence over an existing one) must still run every test. */
function shadowingFindings(after: ConfigView, scope: Scope): Finding[] {
  const findings: Finding[] = [];
  for (const key of [...after.loose.keys()].filter((k) => INCLUDE_RE.test(k))) {
    const patterns = stringValues(after, key);
    if (patterns.length === 0) continue;
    const left = filesNotMatched(scope.testFiles(), scope.configPath, patterns);
    if (left.length === 0) continue;
    findings.push({
      severity: "block",
      line: after.loose.get(key)?.[0]?.line ?? 1,
      detail: `The new ${label(key)} leaves out ${left.length} existing test file(s): ${listSample(left)}`,
      fix: "Include every existing test in the new config, or do not add a config that replaces the current one.",
    });
  }
  return findings;
}

const TEST_HOOK_RE =
  /(^|\.)(alias|setupFiles|setupFilesAfterEnv|globalSetup|moduleNameMapper)(\.|\[|$)/;
const RETRY_RE = /(^|\.)(retry|retries)$/;

function testRunnerFindings(
  beforeAll: ConfigView,
  afterAll: ConfigView,
  fresh: boolean,
  scope: Scope,
  onlyUnderTest = false,
): Finding[] {
  const before = testScope(beforeAll, onlyUnderTest);
  const after = testScope(afterAll, onlyUnderTest);
  const findings: Finding[] = fresh ? [] : thresholdFindings(before, after);
  for (const [path, now] of after.exact) {
    if (!/(^|\.)passWithNoTests$/.test(path) || now.value !== true) continue;
    if (before.exact.get(path)?.value !== true) {
      findings.push({
        severity: "block",
        line: now.line,
        detail: "passWithNoTests was enabled",
        fix: "Remove passWithNoTests; a run that finds no tests must fail.",
      });
    }
  }
  if (fresh) return [...findings, ...shadowingFindings(after, scope)];
  for (const e of grown(
    before,
    after,
    /(^|\.)(exclude|testPathIgnorePatterns|coveragePathIgnorePatterns|modulePathIgnorePatterns|testIgnore|ignore|excludeSpecPattern)\[\]$/,
  )) {
    // Keeping tests, mocks and fixtures out of coverage hides no source code.
    if (/coverage/i.test(e.path) && TEST_LIKE_RE.test(String(e.value))) continue;
    findings.push({
      severity: "block",
      line: e.line,
      detail: `"${String(e.value)}" was added to ${label(e.path)}`,
      fix: "Fix the excluded tests or code instead of removing them from the run.",
    });
  }
  findings.push(
    ...narrowedSets(
      before,
      after,
      /(^|\.)(include|testMatch|spec|specPattern)\[\]$/,
      scope,
      "the test run",
    ),
  );
  const hooks = new Set(
    grown(before, after, TEST_HOOK_RE).map((e) => TEST_HOOK_RE.exec(e.path)?.[2] ?? "alias"),
  );
  for (const key of hooks) {
    findings.push({
      severity: "warn",
      line:
        after.loose.get([...after.loose.keys()].find((k) => TEST_HOOK_RE.test(k)) ?? "")?.[0]
          ?.line ?? 1,
      detail: `Test runner ${key} was added or changed`,
      fix: `Confirm the new ${key} does not replace the code under test with a mock or fake.`,
    });
  }
  for (const [path, now] of after.exact) {
    if (!RETRY_RE.test(path) || typeof now.value !== "number") continue;
    const was = before.exact.get(path)?.value;
    if (now.value > (typeof was === "number" ? was : 0)) {
      findings.push({
        severity: "warn",
        line: now.line,
        detail: `Test retries raised to ${now.value}`,
        fix: "Fix the flaky or failing test instead of retrying it until it passes.",
      });
    }
  }
  return findings;
}

function packageFindings(
  before: ConfigView,
  after: ConfigView,
  fresh: boolean,
  scope: Scope,
): Finding[] {
  const findings: Finding[] = [];
  if (!fresh) {
    for (const [path, entry] of before.exact) {
      const name = /^scripts\.(.+)$/.exec(path)?.[1];
      if (!name || !GUARDED_SCRIPT_RE.test(name)) continue;
      const was = String(entry.value ?? "");
      const nowEntry = after.exact.get(path);
      if (!nowEntry) {
        findings.push({
          severity: "block",
          line: 1,
          detail: `The "${name}" script was removed from package.json`,
          fix: `Restore the "${name}" script; quality gates must keep running.`,
        });
        continue;
      }
      const now = String(nowEntry.value ?? "");
      if (now === was) continue;
      const reason = neutralizedScript(was, now);
      if (reason) {
        findings.push({
          severity: "block",
          line: nowEntry.line,
          detail: `The "${name}" script was weakened (${reason}): "${was}" → "${now}"`,
          fix: `Restore "${was}" and make it pass for real.`,
        });
      } else {
        findings.push({
          severity: "warn",
          line: nowEntry.line,
          detail: `The "${name}" script changed: "${was}" → "${now}"`,
          fix: "Confirm the quality gate still runs everything it ran before.",
        });
      }
    }
  }
  if (!fresh) {
    for (const key of ["workspaces[]", "workspaces.packages[]"]) {
      findings.push(
        ...workspaceNarrowing(
          stringValues(before, key),
          stringValues(after, key),
          "package.json workspaces",
        ),
      );
    }
  }
  findings.push(
    ...eslintFindings(scoped(before, "eslintConfig"), scoped(after, "eslintConfig"), fresh, scope),
  );
  findings.push(...testRunnerFindings(scoped(before, "jest"), scoped(after, "jest"), fresh, scope));
  return findings;
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Globs removed, or new negations ("!packages/core"), narrow the workspace. */
function workspaceNarrowing(
  was: readonly string[],
  now: readonly string[],
  file: string,
): Finding[] {
  const before = new Set(was);
  const after = new Set(now);
  const removed = was.filter((g) => !after.has(g));
  const negated = now.filter((g) => g.startsWith("!") && !before.has(g));
  return [...removed, ...negated].map((glob) => ({
    severity: "block" as const,
    line: 1,
    detail: glob.startsWith("!")
      ? `Workspace packages were excluded with "${glob}" in ${file}`
      : `Workspace package "${glob}" was removed from ${file}`,
    fix: "Restore the workspace: packages outside it are no longer type-checked or tested.",
  }));
}

/** Workspace packages decide what a monorepo type-checks: dropping one narrows the checks. */
function workspaceFindings(change: AnalyzedChange): Finding[] {
  if (change.before === null) return [];
  const was = parsePnpmWorkspace(change.before);
  const now = parsePnpmWorkspace(change.after ?? "");
  return workspaceNarrowing(was, now, change.path);
}

function ignoreFileFindings(change: AnalyzedChange): Finding[] {
  if (change.after === null) return [];
  const old = new Set(splitLines(change.before ?? "").map((l) => l.trim()));
  return splitLines(change.after).flatMap((line, i) => {
    const entry = line.trim();
    if (entry === "" || entry.startsWith("#") || old.has(entry)) return [];
    return [
      {
        severity: "block" as const,
        line: i + 1,
        detail: `"${entry}" was added to ${change.path}`,
        fix: "Fix the lint errors instead of ignoring the files.",
      },
    ];
  });
}

function findingsFor(
  kind: ConfigKind,
  change: AnalyzedChange,
  files: () => readonly string[],
  testFiles: () => readonly string[],
): Finding[] {
  if (kind === "agent-settings") {
    return agentSettingsFindings(change.before, change.after).map((f) => ({
      severity: "block" as const,
      line: 1,
      ...f,
    }));
  }
  if (kind === "eslint-ignore") return ignoreFileFindings(change);
  if (kind === "cheatguard") {
    const verb =
      change.status === "added" ? "created" : change.status === "deleted" ? "deleted" : "modified";
    return [
      {
        severity: "block",
        line: 1,
        detail: `cheatguard.config.json was ${verb}`,
        fix: "Revert changes to cheatguard.config.json; the guard's configuration is owned by the team, not the agent.",
      },
    ];
  }
  const oldPath = change.oldPath;
  if (
    oldPath !== undefined &&
    configKindOf(oldPath) !== null &&
    (configKindOf(change.path) !== configKindOf(oldPath) ||
      basename(change.path) !== basename(oldPath))
  ) {
    return [
      {
        severity: "block",
        line: 0,
        detail: `${oldPath} was renamed to ${change.path}, so the tool may no longer load it`,
        fix: `Rename it back to ${oldPath}.`,
      },
    ];
  }
  if (change.status === "deleted" && change.before !== null) {
    return [
      {
        severity: "block",
        line: 0,
        detail: `${change.path} was deleted`,
        fix: "Restore the config file; deleting it disables the checks it configures.",
      },
    ];
  }
  if (kind === "workspace") return workspaceFindings(change);
  if (kind === "ci") {
    if (change.before === null || change.after === null) return [];
    return ciFindings(change.before, change.after).map((f) => ({
      severity: "block" as const,
      ...f,
    }));
  }
  const scope: Scope = { configPath: change.path, files, testFiles };
  const beforeEntries = configEntries(oldPath ?? change.path, change.before, change.beforeFacts);
  const afterEntries = configEntries(change.path, change.after, change.afterFacts);
  if (beforeEntries && !afterEntries && change.after !== null) {
    return [
      {
        severity: "block",
        line: change.parseError?.line ?? 1,
        detail: `${change.path} no longer parses`,
        fix: "Fix the syntax error; a broken config can silently disable the tool.",
      },
    ];
  }
  if (!afterEntries) return [];
  // A brand-new config can shadow existing ones (nested .eslintrc, vitest.config next to vite.config):
  // compare it against nothing, flagging only explicit relaxations.
  const fresh = change.before === null;
  if (!fresh && !beforeEntries) return [];
  const before = beforeEntries ? view(beforeEntries) : EMPTY;
  const after = view(afterEntries);
  switch (kind) {
    case "tsconfig":
      return tsconfigFindings(before, after, fresh);
    case "package":
      return packageFindings(before, after, fresh, scope);
    case "eslint":
      return eslintFindings(before, after, fresh, scope);
    case "biome":
      return biomeFindings(before, after, fresh, scope);
    case "test-runner":
      return testRunnerFindings(
        before,
        after,
        fresh,
        scope,
        /^(vitest|vite)/.test(basename(change.path)),
      );
  }
}

/** JSON files reached through `extends` from any tsconfig, in the before or after state. */
function extendedTsconfigs(ctx: RuleContext): Set<string> {
  const found = new Set<string>();
  const texts = (path: string): string[] => {
    const change = ctx.changeFor(path);
    const out = [ctx.project.source.read(path), change?.before ?? null];
    return out.filter((t): t is string => t !== null);
  };
  let frontier = [
    ...ctx.project.source.list(),
    ...ctx.changes.map((c) => c.oldPath ?? c.path),
  ].filter((p) => configKindOf(p) === "tsconfig");
  // No depth cap: every file is visited once, so chains of any length end.
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const text of texts(path)) {
        const parsed = parseJsonc(text);
        const ext: unknown =
          typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "extends") : null;
        const list: readonly unknown[] = Array.isArray(ext) ? ext : [ext];
        const targets = list.filter((t): t is string => typeof t === "string" && t.startsWith("."));
        for (const target of targets) {
          const resolved = resolvePath(
            dirOf(path),
            target.endsWith(".json") ? target : `${target}.json`,
          );
          if (!found.has(resolved)) {
            found.add(resolved);
            next.push(resolved);
          }
        }
      }
    }
    frontier = next;
  }
  return found;
}

function resolvePath(dir: string, relative: string): string {
  const stack = dir === "" ? [] : dir.split("/");
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

export const configTampering: Rule = {
  id: "config-tampering",
  scope: "file",
  defaultSeverity: "block",
  description:
    "Quality gates relaxed: strict flags off, lint rules weakened, tests or files excluded, coverage lowered, scripts neutralized.",
  check(ctx) {
    const violations: Violation[] = [];
    let extended: Set<string> | null = null;
    let tests: readonly string[] | null = null;
    const isTest = testMatcher(ctx.config);
    const testFiles = (): readonly string[] => {
      tests ??= ctx.project.source.list().filter(isTest);
      return tests;
    };
    for (const change of ctx.changes) {
      let kind =
        configKindOf(change.path) ?? (change.oldPath ? configKindOf(change.oldPath) : null);
      if (!kind && /\.jsonc?$/.test(change.path)) {
        extended ??= extendedTsconfigs(ctx);
        if (extended.has(change.path) || (change.oldPath && extended.has(change.oldPath)))
          kind = "tsconfig";
      }
      if (!kind || change.skipReason) continue;
      for (const f of findingsFor(kind, change, () => ctx.project.source.list(), testFiles)) {
        violations.push({
          rule: "config-tampering",
          severity: f.severity,
          file: change.path,
          line: f.line,
          detail: f.detail,
          fix: f.fix,
        });
      }
    }
    return violations;
  },
};
