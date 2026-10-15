import ts from "typescript";
import type { Assertion, MockRef, TestCase, TestModifier } from "../adapter.js";
import { startLine, textOf } from "./parse.js";

const SUITE_NAMES = new Set(["describe", "suite", "context"]);
const TEST_NAMES = new Set(["it", "test", "specify"]);
const SKIP_ALIASES: Record<string, { kind: "suite" | "test"; modifier: TestModifier }> = {
  xdescribe: { kind: "suite", modifier: "skip" },
  xcontext: { kind: "suite", modifier: "skip" },
  fdescribe: { kind: "suite", modifier: "only" },
  xit: { kind: "test", modifier: "skip" },
  xtest: { kind: "test", modifier: "skip" },
  xspecify: { kind: "test", modifier: "skip" },
  fit: { kind: "test", modifier: "only" },
};
/** Property modifiers that need no arguments; `null` means the test still runs as written. */
const MODIFIER_PROPS: Record<string, TestModifier | null> = {
  skip: "skip",
  only: "only",
  todo: "todo",
  fails: "fails",
  failing: "fails",
  concurrent: null,
  sequential: null,
};
/** Property modifiers that take arguments first: `it.skipIf(c)(...)`, `it.each(table)(...)`. */
const CALLED_PROPS = new Set(["skipIf", "runIf", "each", "for"]);

interface TestCall {
  kind: "suite" | "test";
  modifier: TestModifier | null;
  name: string;
  callback: ts.ArrowFunction | ts.FunctionExpression | null;
}

type Constant = "truthy" | "falsy" | null;

/** Truthiness of a condition that does not depend on runtime values, or null. */
export function constantTruthiness(expr: ts.Expression): Constant {
  if (ts.isParenthesizedExpression(expr)) return constantTruthiness(expr.expression);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return "truthy";
  if (expr.kind === ts.SyntaxKind.FalseKeyword || expr.kind === ts.SyntaxKind.NullKeyword)
    return "falsy";
  if (ts.isIdentifier(expr) && expr.text === "undefined") return "falsy";
  if (ts.isVoidExpression(expr)) return "falsy";
  if (ts.isNumericLiteral(expr)) return Number(expr.text) === 0 ? "falsy" : "truthy";
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text === "" ? "falsy" : "truthy";
  }
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = constantTruthiness(expr.operand);
    return inner === null ? null : inner === "truthy" ? "falsy" : "truthy";
  }
  return null;
}

/** Modifier implied by `skipIf(c)`, `runIf(c)`, `each(table)` or `for(table)`. */
function calledModifier(prop: string, args: ts.NodeArray<ts.Expression>): TestModifier | null {
  const first = args[0];
  if (prop === "each" || prop === "for") {
    return first && ts.isArrayLiteralExpression(first) && first.elements.length === 0
      ? "empty-table"
      : null;
  }
  // skipIf(false) and runIf(true) never change anything; any other condition can turn the test off.
  const constant = first ? constantTruthiness(first) : null;
  if (prop === "skipIf") return constant === "falsy" ? null : "skipIf";
  return constant === "truthy" ? null : "runIf";
}

/** Resolves `it`, `it.skip`, `describe.only`, `it.each(t)`, `it.skipIf(c)` ... to a base kind and modifier. */
function resolveCallee(
  expr: ts.Expression,
): { kind: "suite" | "test"; modifier: TestModifier | null } | null {
  if (ts.isIdentifier(expr)) {
    if (SUITE_NAMES.has(expr.text)) return { kind: "suite", modifier: null };
    if (TEST_NAMES.has(expr.text)) return { kind: "test", modifier: null };
    return SKIP_ALIASES[expr.text] ?? null;
  }
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (ts.isPropertyAccessExpression(callee) && CALLED_PROPS.has(callee.name.text)) {
      const base = resolveCallee(callee.expression);
      if (!base) return null;
      return {
        kind: base.kind,
        modifier: base.modifier ?? calledModifier(callee.name.text, expr.arguments),
      };
    }
    return resolveCallee(callee);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const prop = expr.name.text;
    if (!(prop in MODIFIER_PROPS)) return null;
    const base = resolveCallee(expr.expression);
    if (!base) return null;
    return { kind: base.kind, modifier: base.modifier ?? MODIFIER_PROPS[prop] ?? null };
  }
  return null;
}

function nameOf(sf: ts.SourceFile, arg: ts.Expression | undefined): string {
  if (!arg) return "(unnamed)";
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return arg.getText(sf).slice(1, -1);
  return textOf(sf, arg);
}

function asTestCall(sf: ts.SourceFile, node: ts.CallExpression): TestCall | null {
  const resolved = resolveCallee(node.expression);
  if (!resolved) return null;
  // A bare `it.each(table)` (not yet invoked with a name) is not itself a test.
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    CALLED_PROPS.has(node.expression.name.text)
  ) {
    return null;
  }
  const callback =
    [...node.arguments]
      .reverse()
      .find(
        (a): a is ts.ArrowFunction | ts.FunctionExpression =>
          ts.isArrowFunction(a) || ts.isFunctionExpression(a),
      ) ?? null;
  return { ...resolved, name: nameOf(sf, node.arguments[0]), callback };
}

function expectRoot(expr: ts.Expression): { call: ts.CallExpression; chain: string[] } | null {
  const chain: string[] = [];
  let cursor: ts.Expression = expr;
  while (true) {
    if (ts.isPropertyAccessExpression(cursor)) {
      chain.unshift(cursor.name.text);
      cursor = cursor.expression;
    } else if (ts.isCallExpression(cursor)) {
      const callee = cursor.expression;
      if (ts.isIdentifier(callee) && callee.text === "expect") return { call: cursor, chain };
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "expect"
      ) {
        // expect.soft(x) / expect.poll(fn)
        return { call: cursor, chain };
      }
      cursor = callee;
    } else {
      return null;
    }
  }
}

/** A literal, or an array/object made only of literals. */
function isLiteralValue(expr: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expr)) return isLiteralValue(expr.expression);
  if (
    ts.isNumericLiteral(expr) ||
    ts.isStringLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    ts.isBigIntLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(expr)) return expr.text === "undefined";
  if (ts.isPrefixUnaryExpression(expr)) return isLiteralValue(expr.operand);
  if (ts.isArrayLiteralExpression(expr)) return expr.elements.every((e) => isLiteralValue(e));
  if (ts.isObjectLiteralExpression(expr)) {
    return expr.properties.every(
      (p) => ts.isPropertyAssignment(p) && isLiteralValue(p.initializer),
    );
  }
  return false;
}

function assertion(
  sf: ts.SourceFile,
  node: ts.CallExpression,
  actual: ts.Expression | undefined,
  matcher: string,
  expectedArgs: readonly ts.Expression[],
  conditional: boolean,
): Assertion {
  return {
    line: startLine(sf, node),
    actual: actual ? textOf(sf, actual) : "",
    matcher,
    expected: expectedArgs.length === 0 ? null : expectedArgs.map((a) => textOf(sf, a)).join(", "),
    conditional,
    vacuous: actual !== undefined && isLiteralValue(actual) && expectedArgs.every(isLiteralValue),
  };
}

function asAssertion(
  sf: ts.SourceFile,
  node: ts.CallExpression,
  conditional: boolean,
): Assertion | null {
  const callee = node.expression;
  if (ts.isIdentifier(callee) && callee.text === "assert") {
    return assertion(sf, node, node.arguments[0], "assert", node.arguments.slice(1), conditional);
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "assert"
  ) {
    return assertion(
      sf,
      node,
      node.arguments[0],
      `assert.${callee.name.text}`,
      node.arguments.slice(1),
      conditional,
    );
  }
  if (!ts.isPropertyAccessExpression(callee)) return null;
  // Only the outermost call of an expect chain counts.
  const parent = node.parent;
  if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) return null;
  const root = expectRoot(callee);
  if (!root || root.chain.length === 0) return null;
  return assertion(
    sf,
    node,
    root.call.arguments[0],
    root.chain.join("."),
    node.arguments,
    conditional,
  );
}

type FunctionLike = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

/** Name a function is bound to (`const f = () => {}`, `function f() {}`), if any. */
function boundName(fn: FunctionLike): ts.Identifier | null {
  if (ts.isFunctionDeclaration(fn)) return fn.name ?? null;
  let node: ts.Node = fn;
  while (node.parent && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (
    parent &&
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name;
  }
  return null;
}

/** True when an identifier with this name, other than the binding itself, appears in `scope`. */
function referenced(scope: ts.Node, binding: ts.Identifier): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node !== binding && node.text === binding.text) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

const CONDITIONAL_PARENTS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.DefaultClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);

const SHORT_CIRCUIT = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function isTerminator(statement: ts.Statement): boolean {
  return ts.isReturnStatement(statement) || ts.isThrowStatement(statement);
}

/**
 * Assertions that can run when the test body runs. Code after an unconditional return/throw, branches
 * behind a constant-false condition and functions that are never called are skipped; assertions behind
 * a runtime condition are marked `conditional`.
 */
function collectAssertions(sf: ts.SourceFile, body: ts.Node): Assertion[] {
  const assertions: Assertion[] = [];
  const visit = (node: ts.Node, conditional: boolean): void => {
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      const name = boundName(node);
      if (name && !referenced(body, name)) return;
      if (node.body) visit(node.body, conditional);
      return;
    }
    if (
      ts.isBlock(node) ||
      ts.isCaseClause(node) ||
      ts.isDefaultClause(node) ||
      ts.isSourceFile(node)
    ) {
      const inner = conditional || ts.isCaseClause(node) || ts.isDefaultClause(node);
      if (ts.isCaseClause(node)) visit(node.expression, conditional);
      for (const statement of node.statements) {
        visit(statement, inner);
        if (isTerminator(statement)) break;
      }
      return;
    }
    if (ts.isIfStatement(node)) {
      visit(node.expression, conditional);
      const constant = constantTruthiness(node.expression);
      if (constant !== "falsy") visit(node.thenStatement, conditional || constant === null);
      if (node.elseStatement && constant !== "truthy") {
        visit(node.elseStatement, conditional || constant === null);
      }
      return;
    }
    if (ts.isWhileStatement(node) && constantTruthiness(node.expression) === "falsy") return;
    if (ts.isBinaryExpression(node) && SHORT_CIRCUIT.has(node.operatorToken.kind)) {
      visit(node.left, conditional);
      visit(node.right, true);
      return;
    }
    if (ts.isCallExpression(node)) {
      const found = asAssertion(sf, node, conditional);
      if (found) assertions.push(found);
    }
    const childConditional = conditional || CONDITIONAL_PARENTS.has(node.kind);
    ts.forEachChild(node, (child) => visit(child, childConditional));
  };
  visit(body, false);
  return assertions;
}

const MOCK_CALLS = new Set(["mock", "doMock", "unstable_mockModule"]);

/** `vi.mock("./x")`, `jest.mock("./x", factory)`, `vi.doMock(...)` calls anywhere in the file. */
export function extractMocks(sf: ts.SourceFile): MockRef[] {
  const mocks: MockRef[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ["vi", "jest"].includes(node.expression.expression.text) &&
      MOCK_CALLS.has(node.expression.name.text)
    ) {
      const first = node.arguments[0];
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        mocks.push({ specifier: first.text, line: startLine(sf, node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return mocks;
}

export function extractTests(sf: ts.SourceFile): TestCase[] {
  const tests: TestCase[] = [];
  const seen = new Map<string, number>();
  const visit = (node: ts.Node, path: readonly string[], inherited: TestModifier | null): void => {
    if (ts.isCallExpression(node)) {
      const call = asTestCall(sf, node);
      if (call) {
        const modifier = call.modifier ?? inherited;
        if (call.kind === "suite") {
          if (call.callback) visit(call.callback.body, [...path, call.name], modifier);
          return;
        }
        const base = [...path, call.name].join(" > ");
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        tests.push({
          id: count === 1 ? base : `${base} #${count}`,
          line: startLine(sf, node),
          modifier,
          assertions: call.callback ? collectAssertions(sf, call.callback.body) : [],
        });
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, path, inherited));
  };
  visit(sf, [], null);
  return tests;
}
