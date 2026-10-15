import ts from "typescript";
import type { ImportRef } from "../adapter.js";
import { startLine } from "./parse.js";

function literalText(node: ts.Node | undefined): string | null {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)))
    return node.text;
  return null;
}

function bindingNames(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (!clause) return [];
  const names: string[] = [];
  if (clause.name) names.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
  if (bindings && ts.isNamedImports(bindings))
    for (const el of bindings.elements) names.push(el.name.text);
  return names;
}

export function extractImports(sf: ts.SourceFile): ImportRef[] {
  const imports: ImportRef[] = [];
  const add = (
    specifier: string | null,
    node: ts.Node,
    typeOnly: boolean,
    names: string[] = [],
  ): void => {
    if (specifier !== null) imports.push({ specifier, line: startLine(sf, node), typeOnly, names });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(
        literalText(node.moduleSpecifier),
        node,
        node.importClause?.isTypeOnly ?? false,
        bindingNames(node),
      );
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(literalText(node.moduleSpecifier), node, node.isTypeOnly);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(literalText(node.moduleReference.expression), node, node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) add(literalText(node.arguments[0]), node, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return imports;
}
