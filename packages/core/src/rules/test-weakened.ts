import type { Assertion, FileFacts, TestCase, TestModifier } from "../lang/adapter.js";
import type { Violation } from "../types.js";
import type { AnalyzedChange, Rule, RuleContext } from "./types.js";

const IDENT_RE = /[A-Za-z_$][\w$]*/g;

function signature(test: TestCase): string {
  return test.assertions
    .map((a) => `${a.actual}|${a.matcher}|${a.expected ?? ""}`)
    .sort()
    .join("\n");
}

/** Relative imports of a test file that point at modules changed (or deleted) in this diff. */
const SUBJECT_DEPTH = 4;
const SUBJECT_MAX_FILES = 200;

/**
 * Changed (non-test) modules reachable from a test through relative imports, following barrels
 * and re-exports a few levels deep.
 */
function changedSubjects(ctx: RuleContext, testPath: string, facts: FileFacts): AnalyzedChange[] {
  const subjects: AnalyzedChange[] = [];
  const seen = new Set<string>([testPath]);
  let frontier: Array<{ from: string; facts: FileFacts }> = [{ from: testPath, facts }];
  for (
    let depth = 0;
    depth < SUBJECT_DEPTH && frontier.length > 0 && seen.size < SUBJECT_MAX_FILES;
    depth += 1
  ) {
    const next: Array<{ from: string; facts: FileFacts }> = [];
    for (const { from, facts: current } of frontier) {
      for (const imp of current.imports) {
        if (!imp.specifier.startsWith(".")) continue;
        const resolved = resolveAnyState(ctx, from, imp.specifier);
        if (!resolved || seen.has(resolved)) continue;
        seen.add(resolved);
        const change = ctx.changeFor(resolved);
        if (change && !change.isTest) subjects.push(change);
        const nested = change?.afterFacts ?? change?.beforeFacts ?? ctx.factsOf(resolved);
        if (nested) next.push({ from: resolved, facts: nested });
      }
    }
    frontier = next;
  }
  return subjects;
}

/** Resolves a relative import against the after state, falling back to deleted files of the diff. */
function resolveAnyState(ctx: RuleContext, fromFile: string, specifier: string): string | null {
  const resolved = ctx.project.resolveRelative(fromFile, specifier);
  if (resolved) return resolved;
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const parts = `${dir}/${specifier}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const base = stack.join("/").replace(/\.[cm]?jsx?$/, "");
  for (const change of ctx.changes) {
    if (change.status !== "deleted") continue;
    const candidate = change.path.replace(/\.[cm]?[jt]sx?$/, "");
    if (candidate === base || candidate === `${base}/index`) return change.path;
  }
  return null;
}

/** Exported names removed from a module in this diff (all names when the module was deleted). */
function removedExports(change: AnalyzedChange): Set<string> {
  const before = new Set(change.beforeFacts?.exports ?? []);
  if (change.status === "deleted") return before;
  for (const name of change.afterFacts?.exports ?? []) before.delete(name);
  return before;
}

/** A removed test is legitimate when it exercised a symbol whose export was removed in this diff. */
function subjectRemoved(
  ctx: RuleContext,
  testPath: string,
  facts: FileFacts,
  test: TestCase,
): boolean {
  const used = new Set(test.assertions.flatMap((a) => a.actual.match(IDENT_RE) ?? []));
  for (const imp of facts.imports) {
    if (!imp.specifier.startsWith(".")) continue;
    const resolved = resolveAnyState(ctx, testPath, imp.specifier);
    const change = resolved ? ctx.changeFor(resolved) : undefined;
    if (!change) continue;
    const removed = removedExports(change);
    if (change.status === "deleted" && imp.names.length === 0) return true;
    if (
      imp.names.some((name) => used.has(name) && (removed.has(name) || change.status === "deleted"))
    ) {
      return true;
    }
  }
  return false;
}

interface AssertionPairs {
  /** Same value and matcher, different expected value. */
  value: Array<{ was: Assertion; now: Assertion }>;
  /** Same value, different matcher. */
  matcher: Array<{ was: Assertion; now: Assertion }>;
}

function pairAssertions(before: Assertion[], after: Assertion[]): AssertionPairs {
  const remaining = [...after];
  const take = (match: (a: Assertion) => boolean): Assertion | undefined => {
    const index = remaining.findIndex(match);
    return index >= 0 ? remaining.splice(index, 1)[0] : undefined;
  };
  // Exact matches first, so reorderings never look like edits.
  const unmatched = before.filter(
    (b) =>
      !take((a) => a.actual === b.actual && a.matcher === b.matcher && a.expected === b.expected),
  );
  const pairs: AssertionPairs = { value: [], matcher: [] };
  const noValueMatch: Assertion[] = [];
  for (const b of unmatched) {
    const now = take((a) => a.actual === b.actual && a.matcher === b.matcher);
    if (now) pairs.value.push({ was: b, now });
    else noValueMatch.push(b);
  }
  for (const b of noValueMatch) {
    const now = take((a) => a.actual === b.actual);
    if (now) pairs.matcher.push({ was: b, now });
  }
  return pairs;
}

/** Matchers that accept almost any value of the right shape. */
const WEAK_MATCHERS = new Set([
  "toBeDefined",
  "toBeTruthy",
  "toBeFalsy",
  "toBeTypeOf",
  "toBeInstanceOf",
  "toHaveBeenCalled",
  "toBeCalled",
]);
const ASYMMETRIC_ANY_RE = /\bexpect\.(anything|any)\(/;

function isWeak(a: Assertion): boolean {
  const matcher = a.matcher.replace(/^(resolves|rejects)\./, "").replace(/^not\./, "");
  return WEAK_MATCHERS.has(matcher) || ASYMMETRIC_ANY_RE.test(a.expected ?? "");
}

/** True when `now` accepts values that `was` rejected: a vaguer matcher, a negation or a wildcard. */
function weakerThan(was: Assertion, now: Assertion): boolean {
  if (isWeak(was)) return false;
  if (isWeak(now)) return true;
  const negated = (a: Assertion): boolean => /^((resolves|rejects)\.)?not\./.test(a.matcher);
  if (negated(now) && !negated(was)) return true;
  return /toThrow(Error)?$/.test(now.matcher) && now.expected === null && was.expected !== null;
}

const counted = (test: TestCase): Assertion[] => test.assertions.filter((a) => !a.vacuous);
const unconditional = (test: TestCase): number =>
  counted(test).filter((a) => !a.conditional).length;
const show = (a: Assertion): string => `expect(${a.actual}).${a.matcher}(${a.expected ?? ""})`;

const MODIFIER_TEXT: Record<TestModifier, { detail: string; fix: string }> = {
  skip: {
    detail: "was marked .skip",
    fix: "Remove the skip and fix the behavior the test exercises.",
  },
  todo: {
    detail: "was turned into .todo",
    fix: "Restore the test body and make the implementation pass it.",
  },
  only: {
    detail: "was marked .only",
    fix: "Remove .only — it silently disables every other test in the run.",
  },
  fails: {
    detail: "was marked .fails (it now passes only while the code is broken)",
    fix: "Remove .fails and fix the behavior the test exercises.",
  },
  skipIf: {
    detail: "was made conditional with .skipIf(...)",
    fix: "Remove the condition and fix the behavior: a test that does not run checks nothing.",
  },
  runIf: {
    detail: "was made conditional with .runIf(...)",
    fix: "Remove the condition and fix the behavior: a test that does not run checks nothing.",
  },
  "empty-table": {
    detail: "now runs over an empty table (.each([]) runs nothing)",
    fix: "Restore the table rows and make the implementation pass every case.",
  },
};

const lastSegment = (id: string): string => (id.split(" > ").pop() ?? id).replace(/ #\d+$/, "");
const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

/** Same describe path and a title that was extended, shortened or lightly reworded. */
function similarTitles(a: string, b: string): boolean {
  const scopeA = a.split(" > ").slice(0, -1).join(" > ");
  const scopeB = b.split(" > ").slice(0, -1).join(" > ");
  if (scopeA !== scopeB) return false;
  const ta = lastSegment(a).toLowerCase();
  const tb = lastSegment(b).toLowerCase();
  if (ta.length >= 8 && tb.length >= 8 && (ta.startsWith(tb) || tb.startsWith(ta))) return true;
  const wa = words(ta);
  const wb = words(tb);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return wa.size > 0 && shared / (wa.size + wb.size - shared) >= 0.6;
}

/** A test removed here but present (same title or same assertions) in another test file of the change. */
type Moved = { kind: "moved" } | { kind: "weaker"; file: string; from: number; to: number } | null;

/** A test removed here but present (same title or same assertions) in another test file of the change. */
function movedToAnotherFile(ctx: RuleContext, change: AnalyzedChange, test: TestCase): Moved {
  const title = lastSegment(test.id);
  const sig = signature(test);
  let weaker: Moved = null;
  for (const other of ctx.changes) {
    if (other === change || !other.afterIsTest) continue;
    for (const t of other.afterFacts?.tests ?? []) {
      if (sig !== "" && signature(t) === sig) return { kind: "moved" };
      if (lastSegment(t.id) !== title) continue;
      if (counted(t).length >= counted(test).length) return { kind: "moved" };
      weaker = {
        kind: "weaker",
        file: other.path,
        from: counted(test).length,
        to: counted(t).length,
      };
    }
  }
  return weaker;
}

/** New module mocks that replace a module whose exports the tests assert on. */
function subjectMocks(
  change: AnalyzedChange,
  before: FileFacts | null,
  after: FileFacts,
): Violation[] {
  const existing = new Set((before?.mocks ?? []).map((m) => m.specifier));
  const asserted = new Set(
    after.tests.flatMap((t) => t.assertions.flatMap((a) => a.actual.match(IDENT_RE) ?? [])),
  );
  const violations: Violation[] = [];
  for (const mock of after.mocks) {
    if (existing.has(mock.specifier) || !mock.specifier.startsWith(".")) continue;
    const subject = after.imports.some(
      (imp) => imp.specifier === mock.specifier && imp.names.some((n) => asserted.has(n)),
    );
    if (!subject) continue;
    violations.push({
      rule: "test-weakened",
      severity: "warn",
      file: change.path,
      line: mock.line,
      detail: `New mock of "${mock.specifier}" replaces the module the tests assert on`,
      fix: "Test the real module and mock only its dependencies; a mocked subject makes the assertions check the mock.",
    });
  }
  return violations;
}

function checkFile(ctx: RuleContext, change: AnalyzedChange): Violation[] {
  const violations: Violation[] = [];
  const before = change.beforeFacts;
  const add = (
    line: number,
    detail: string,
    fix: string,
    severity: "block" | "warn" = "block",
  ): void => {
    violations.push({ rule: "test-weakened", severity, file: change.path, line, detail, fix });
  };

  // A test file deleted, or renamed to a name the runner does not collect (.bak, .md, fixtures/...).
  const goneFromRunner =
    change.status === "deleted" || (change.status === "renamed" && !change.afterIsTest);
  if (goneFromRunner) {
    if (!before || before.tests.length === 0) return [];
    const from = change.oldPath ?? change.path;
    const subjects = before.imports.filter((i) => i.specifier.startsWith("."));
    const allSubjectsDeleted =
      subjects.length > 0 &&
      subjects.every((imp) => {
        const resolved = resolveAnyState(ctx, from, imp.specifier);
        return resolved !== null && ctx.changeFor(resolved)?.status === "deleted";
      });
    if (allSubjectsDeleted) return [];
    // Every test reappears in another test file of the change (with at least its assertions): a move
    // git did not detect as a rename.
    const moves = before.tests.map((test) => movedToAnotherFile(ctx, change, test));
    if (moves.every((m) => m?.kind === "moved")) return [];
    const weaker = moves.find((m) => m?.kind === "weaker");
    if (weaker?.kind === "weaker" && moves.every((m) => m !== null)) {
      // A "moved" test that arrives with no assertions at all is a deleted test.
      const emptied = moves.some((m) => m?.kind === "weaker" && m.to === 0);
      add(
        0,
        `Tests of ${from} moved to ${weaker.file} with fewer assertions (${weaker.from} → ${weaker.to} in one of them)`,
        emptied
          ? "Restore the assertions: a moved test without assertions checks nothing."
          : "Confirm the moved tests still check everything the originals did.",
        emptied ? "block" : "warn",
      );
      return violations;
    }
    if (change.status === "deleted") {
      add(
        0,
        `Deleted test file with ${before.tests.length} tests`,
        "Restore the test file and make the implementation pass it. Delete tests only together with the code they cover.",
      );
    } else {
      add(
        0,
        `Test file ${from} was moved to ${change.path}, where the test runner no longer runs it (${before.tests.length} tests)`,
        `Move it back to ${from} and make the implementation pass it.`,
      );
    }
    return violations;
  }

  const after = change.afterFacts;
  if (!after) return [];
  const beforeTests = before?.tests ?? [];
  const afterById = new Map(after.tests.map((t) => [t.id, t]));
  const beforeIds = new Set(beforeTests.map((t) => t.id));
  const unmatchedAfter = after.tests.filter((t) => !beforeIds.has(t.id));
  const pairs: Array<{ was: TestCase; now: TestCase }> = [];
  const removed: TestCase[] = [];

  for (const was of beforeTests) {
    const now = afterById.get(was.id);
    if (now) {
      pairs.push({ was, now });
      continue;
    }
    // A test renamed without touching its assertions is the same test.
    const sig = signature(was);
    let renamedIndex = sig === "" ? -1 : unmatchedAfter.findIndex((t) => signature(t) === sig);
    // Reworded titles ("x" → "x and says nothing") pair up too; their assertions are then compared.
    if (renamedIndex < 0)
      renamedIndex = unmatchedAfter.findIndex((t) => similarTitles(was.id, t.id));
    const renamed = renamedIndex >= 0 ? unmatchedAfter.splice(renamedIndex, 1)[0] : undefined;
    if (renamed) pairs.push({ was, now: renamed });
    else removed.push(was);
  }

  for (const test of removed) {
    if (before && subjectRemoved(ctx, change.oldPath ?? change.path, before, test)) continue;
    const moved = movedToAnotherFile(ctx, change, test);
    if (moved?.kind === "moved") continue;
    if (moved?.kind === "weaker") {
      add(
        0,
        `Test "${test.id}" moved to ${moved.file} with fewer assertions (${moved.from} → ${moved.to})`,
        moved.to === 0
          ? "Restore the assertions: a moved test without assertions checks nothing."
          : "Confirm the moved test still checks everything the original did.",
        moved.to === 0 ? "block" : "warn",
      );
      continue;
    }
    add(
      0,
      `Deleted test: "${test.id}" (${test.assertions.length} assertions)`,
      `Restore "${test.id}" and make the implementation pass it. Remove a test only when the feature it covers is removed.`,
    );
  }

  const subjectsChanged = before
    ? changedSubjects(ctx, change.oldPath ?? change.path, before).length > 0
    : false;

  for (const { was, now } of pairs) {
    if (now.modifier && now.modifier !== was.modifier) {
      const text = MODIFIER_TEXT[now.modifier];
      add(now.line, `Test "${now.id}" ${text.detail}`, text.fix);
      continue;
    }
    const wasCount = counted(was).length;
    const nowCount = counted(now).length;
    if (nowCount < wasCount) {
      add(
        now.line,
        `Test "${now.id}" went from ${wasCount} to ${nowCount} assertions that can run and check something`,
        `Restore the removed assertions in "${now.id}" (unreachable code and literal-only checks like expect(4).toBe(4) do not count) and fix the implementation instead.`,
      );
      continue;
    }
    const severity = subjectsChanged ? "warn" : "block";
    const pairsOf = pairAssertions(counted(was), counted(now));
    for (const { was: a, now: b } of pairsOf.value) {
      if (weakerThan(a, b)) {
        add(
          b.line,
          `Assertion made weaker in "${now.id}": ${show(a)} → ${show(b)}`,
          subjectsChanged
            ? "The code under test changed too; confirm the requirement changed. If not, restore the exact expectation."
            : "Restore the exact expectation and fix the code under test.",
          severity,
        );
        continue;
      }
      const detail = `Expected value changed in "${now.id}": ${show(a)} → (${b.expected ?? ""})`;
      add(
        b.line,
        detail,
        subjectsChanged
          ? "The code under test changed too; confirm the requirement changed. If not, revert the expectation and fix the code."
          : "Revert the expected value and fix the code under test so it produces the original result.",
        severity,
      );
    }
    for (const { was: a, now: b } of pairsOf.matcher) {
      if (!weakerThan(a, b)) continue;
      add(
        b.line,
        `Assertion made weaker in "${now.id}": ${show(a)} → ${show(b)}`,
        subjectsChanged
          ? "The code under test changed too; confirm the requirement changed. If not, restore the exact matcher."
          : "Restore the exact matcher and expected value, and fix the code under test.",
        severity,
      );
    }
    const lostUnconditional = unconditional(was) - unconditional(now);
    if (lostUnconditional > 0) {
      add(
        now.line,
        `Test "${now.id}": ${lostUnconditional} assertion(s) now run only conditionally (inside an if, loop, catch or ternary)`,
        "Make sure the assertions still run on every test run; a condition that is never true turns the test off.",
        "warn",
      );
    }
  }

  for (const test of unmatchedAfter) {
    if (test.modifier === "only")
      add(test.line, `New test "${test.id}" uses .only`, MODIFIER_TEXT.only.fix);
  }

  violations.push(...subjectMocks(change, before, after));
  return violations;
}

export const testWeakened: Rule = {
  id: "test-weakened",
  scope: "file",
  defaultSeverity: "block",
  description:
    "Tests deleted, assertions removed, tests skipped/focused, or expected values edited to match the code.",
  check(ctx) {
    return ctx.changes
      .filter((c) => c.isTest && (c.supported || c.beforeFacts !== null) && !c.parseError)
      .flatMap((c) => checkFile(ctx, c));
  },
};
