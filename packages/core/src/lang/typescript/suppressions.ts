import ts from "typescript";
import type { Suppression, SuppressionKind } from "../adapter.js";
import type { CommentToken } from "./comments.js";
import { lineText, startLine } from "./parse.js";

const DIRECTIVES: ReadonlyArray<[RegExp, SuppressionKind]> = [
  [/^@ts-ignore\b/, "ts-ignore"],
  [/^@ts-expect-error\b/, "ts-expect-error"],
  [/^@ts-nocheck\b/, "ts-nocheck"],
  [/^(eslint|oxlint)-disable(-next-line|-line)?\b/, "eslint-disable"],
  [/^biome-ignore(-all|-start)?\b/, "biome-ignore"],
  [/^(v8|c8|istanbul)\s+ignore\b/, "coverage-ignore"],
];

function unwrapParens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

export function extractSuppressions(
  sf: ts.SourceFile,
  comments: readonly CommentToken[],
): Suppression[] {
  const found: Array<Suppression & { pos: number }> = [];
  for (const comment of comments) {
    for (const [re, kind] of DIRECTIVES) {
      if (re.test(comment.body)) {
        found.push({
          kind,
          line: comment.line,
          text: lineText(sf, comment.line),
          pos: comment.pos,
        });
        break;
      }
    }
  }
  const record = (kind: SuppressionKind, node: ts.Node): void => {
    const line = startLine(sf, node);
    found.push({ kind, line, text: lineText(sf, line), pos: node.getStart(sf) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (node.type.kind === ts.SyntaxKind.AnyKeyword) {
        record("as-any", node);
        ts.forEachChild(node.expression, visit);
        return;
      }
      if (node.type.kind === ts.SyntaxKind.NeverKeyword) {
        record("as-never", node);
        ts.forEachChild(node.expression, visit);
        return;
      }
      // `x as unknown as T`, `<T><unknown>x`, `<T>(x as unknown)`: any value forced into any type.
      const inner = unwrapParens(node.expression);
      if (
        (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) &&
        inner.type.kind === ts.SyntaxKind.UnknownKeyword
      ) {
        record("as-unknown-as", node);
        ts.forEachChild(inner.expression, visit);
        ts.forEachChild(node.type, visit);
        return;
      }
    }
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === "Function"
    ) {
      record("function-type", node);
    }
    // `declare module "x";` without a body types every import from "x" as any.
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && !node.body) {
      record("untyped-module", node);
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) record("any", node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found.sort((a, b) => a.pos - b.pos).map(({ kind, line, text }) => ({ kind, line, text }));
}
