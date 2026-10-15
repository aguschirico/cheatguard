import ts from "typescript";
import type { BodyKind, FunctionInfo, NotImplementedThrow } from "../adapter.js";
import { startLine, textOf } from "./parse.js";

const NOT_IMPLEMENTED_RE =
  /\b(not\s+(yet\s+)?implemented|unimplemented|implement\s+me|todo|tbd|fixme)\b|^\s*todo\b/i;

const STATEMENT_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ContinueStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.WithStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.DebuggerStatement,
  ts.SyntaxKind.FunctionDeclaration,
]);

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;
type FunctionBody = ts.Block | ts.Expression;

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false)
    : false;
}

function countStatements(body: FunctionBody): number {
  if (!ts.isBlock(body)) return 1;
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (STATEMENT_KINDS.has(node.kind)) count += 1;
    ts.forEachChild(node, visit);
  };
  for (const statement of body.statements) visit(statement);
  return count;
}

function isLiteralish(expr: ts.Expression | undefined): boolean {
  if (!expr) return true;
  if (ts.isParenthesizedExpression(expr)) return isLiteralish(expr.expression);
  switch (expr.kind) {
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.VoidExpression:
      return true;
    default:
      break;
  }
  if (ts.isIdentifier(expr)) return expr.text === "undefined";
  if (ts.isArrayLiteralExpression(expr)) return expr.elements.length === 0;
  if (ts.isObjectLiteralExpression(expr)) return expr.properties.length === 0;
  if (ts.isPrefixUnaryExpression(expr)) return ts.isNumericLiteral(expr.operand);
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr))
    return isLiteralish(expr.expression);
  return false;
}

export function isNotImplementedThrow(statement: ts.Node): statement is ts.ThrowStatement {
  if (!ts.isThrowStatement(statement)) return false;
  const expr = statement.expression;
  if (!ts.isNewExpression(expr)) return false;
  if (
    ts.isIdentifier(expr.expression) &&
    /notimplemented|unimplemented/i.test(expr.expression.text)
  ) {
    return true;
  }
  const arg = expr.arguments?.[0];
  if (!arg) return false;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
    return NOT_IMPLEMENTED_RE.test(arg.text);
  if (ts.isTemplateExpression(arg)) return NOT_IMPLEMENTED_RE.test(arg.head.text);
  return false;
}

function bodyKind(body: FunctionBody): BodyKind {
  if (!ts.isBlock(body)) return isLiteralish(body) ? "literal-return" : "normal";
  if (body.statements.length === 0) return "empty";
  if (body.statements.length !== 1) return "normal";
  const only = body.statements[0];
  if (!only) return "normal";
  if (ts.isReturnStatement(only))
    return isLiteralish(only.expression) ? "literal-return" : "normal";
  if (isNotImplementedThrow(only)) return "throw-not-implemented";
  return "normal";
}

function bodyTokens(sf: ts.SourceFile, body: FunctionBody): string[] {
  let text = body.getText(sf);
  if (ts.isBlock(body)) text = text.slice(1, -1);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, sf.languageVariant, text);
  const tokens: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    tokens.push(
      kind === ts.SyntaxKind.Identifier
        ? scanner.getTokenText().toLowerCase()
        : scanner.getTokenText(),
    );
  }
  return tokens;
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

/** Names exported via `export { a, b as c }`, `export default a` or `module.exports = { a }`. */
function collectExportedNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements)
          names.add((el.propertyName ?? el.name).text);
      }
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      names.add(statement.expression.text);
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const { left, right } = statement.expression;
      const target = left.getText(sf);
      if (target === "module.exports" && ts.isObjectLiteralExpression(right)) {
        for (const prop of right.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) names.add(prop.name.text);
          else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer))
            names.add(prop.initializer.text);
        }
      } else if (target === "module.exports" && ts.isIdentifier(right)) {
        names.add(right.text);
      }
    }
  }
  return names;
}

export function extractFunctions(sf: ts.SourceFile): {
  functions: FunctionInfo[];
  notImplemented: NotImplementedThrow[];
} {
  const functions: FunctionInfo[] = [];
  const notImplemented: NotImplementedThrow[] = [];
  const exportedNames = collectExportedNames(sf);

  const add = (name: string, fn: FunctionLike, exported: boolean): void => {
    const body = fn.body;
    if (!body) return;
    functions.push({
      name,
      line: startLine(sf, fn),
      exported: exported || exportedNames.has(name),
      statementCount: countStatements(body),
      bodyKind: bodyKind(body),
      tokens: bodyTokens(sf, body),
    });
  };

  const visit = (node: ts.Node, className: string | null): void => {
    if (ts.isThrowStatement(node) && isNotImplementedThrow(node)) {
      notImplemented.push({ line: startLine(sf, node), text: textOf(sf, node) });
    }
    if (ts.isFunctionDeclaration(node)) {
      const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
      add(
        node.name?.text ?? (isDefault ? "default" : "anonymous"),
        node,
        hasModifier(node, ts.SyntaxKind.ExportKeyword),
      );
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = node.name?.text ?? "default";
      for (const member of node.members) visit(member, name);
      return;
    } else if (ts.isMethodDeclaration(node)) {
      const name = propertyNameText(node.name);
      if (name) add(className ? `${className}.${name}` : name, node, false);
    } else if (ts.isPropertyDeclaration(node) && className && node.initializer) {
      const name = propertyNameText(node.name);
      const init = node.initializer;
      if (name && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
        add(`${className}.${name}`, init, false);
    } else if (ts.isVariableStatement(node)) {
      const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
      for (const decl of node.declarationList.declarations) {
        const init = decl.initializer;
        const name = propertyNameText(decl.name);
        if (name && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
          add(name, init, exported);
      }
    }
    ts.forEachChild(node, (child) => visit(child, className));
  };
  visit(sf, null);
  return { functions, notImplemented };
}
