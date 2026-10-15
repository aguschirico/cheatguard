import ts from "typescript";
import { configKindOf } from "../../config-kind.js";
import type { LiteralEntry, LiteralValue } from "../adapter.js";
import { startLine } from "./parse.js";

const CONFIG_PATH_RE =
  /(^|\/)((vitest|vite|jest|eslint|tsup|playwright|prettier|babel|webpack|rollup|cypress|karma|ava|mocha|biome)\.config|\.eslintrc|\.mocharc|jest\.setup|vitest\.workspace)(\.[\w-]+)*\.[cm]?[jt]s$/i;

export function isConfigLikePath(path: string): boolean {
  return configKindOf(path) !== null || CONFIG_PATH_RE.test(path);
}

function literalValue(expr: ts.Expression): LiteralValue | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return -Number(expr.operand.text);
  }
  return undefined;
}

function keyText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression))
    return name.expression.text;
  return null;
}

export function extractLiterals(sf: ts.SourceFile): LiteralEntry[] {
  const entries: LiteralEntry[] = [];
  const join = (prefix: string, key: string): string => (prefix ? `${prefix}.${key}` : key);

  const walkValue = (expr: ts.Expression, path: string): void => {
    const value = literalValue(expr);
    if (value !== undefined) {
      entries.push({ path, value, line: startLine(sf, expr) });
    } else if (ts.isObjectLiteralExpression(expr)) {
      walkObject(expr, path);
    } else if (ts.isArrayLiteralExpression(expr)) {
      for (const [i, el] of expr.elements.entries()) walkValue(el, `${path}[${i}]`);
    } else if (
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isParenthesizedExpression(expr)
    ) {
      walkValue(expr.expression, path);
    }
  };

  const walkObject = (obj: ts.ObjectLiteralExpression, prefix: string): void => {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = keyText(prop.name);
      if (key !== null) walkValue(prop.initializer, join(prefix, key));
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      walkObject(node, "");
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      walkValue(node, "");
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return entries;
}
