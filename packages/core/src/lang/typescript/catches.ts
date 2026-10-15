import ts from "typescript";
import type { CatchInfo, CatchKind } from "../adapter.js";
import { startLine, textOf } from "./parse.js";

function isConsoleCall(expr: ts.Expression): boolean {
  return (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "console"
  );
}

function isPlaceholder(expr: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expr)) return isPlaceholder(expr.expression);
  return (
    expr.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expr) && expr.text === "undefined") ||
    ts.isVoidExpression(expr) ||
    (ts.isObjectLiteralExpression(expr) && expr.properties.length === 0)
  );
}

function classifyBlock(sf: ts.SourceFile, block: ts.Block): CatchKind {
  if (block.statements.length === 0) {
    const inner = block.getText(sf).slice(1, -1).trim();
    return inner.length > 0 ? "comment-only" : "empty";
  }
  const allLogs = block.statements.every(
    (s) => ts.isExpressionStatement(s) && isConsoleCall(s.expression),
  );
  return allLogs ? "log-only" : "handled";
}

function classifyHandler(
  sf: ts.SourceFile,
  fn: ts.ArrowFunction | ts.FunctionExpression,
): CatchKind {
  if (ts.isBlock(fn.body)) return classifyBlock(sf, fn.body);
  if (isConsoleCall(fn.body)) return "log-only";
  // `.catch(() => undefined)`, `.catch(() => null)`: the error becomes a placeholder value.
  return isPlaceholder(fn.body) ? "empty" : "handled";
}

export function extractCatches(sf: ts.SourceFile): CatchInfo[] {
  const catches: CatchInfo[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) {
      catches.push({
        line: startLine(sf, node),
        kind: classifyBlock(sf, node.block),
        text: textOf(sf, node),
      });
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch" &&
      node.arguments.length === 1
    ) {
      const handler = node.arguments[0];
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        catches.push({
          line: startLine(sf, node.expression.name),
          kind: classifyHandler(sf, handler),
          text: `.catch(${textOf(sf, handler)})`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return catches;
}
