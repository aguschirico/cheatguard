import ts from "typescript";

function hasExport(node: ts.Node): { exported: boolean; isDefault: boolean } {
  const mods = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  return {
    exported: mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
    isDefault: mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword),
  };
}

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

export function extractExports(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of sf.statements) {
    const { exported, isDefault } = hasExport(statement);
    if (exported) {
      if (isDefault) names.push("default");
      else if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) bindingNames(decl.name, names);
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isModuleDeclaration(statement)) &&
        statement.name &&
        ts.isIdentifier(statement.name)
      ) {
        names.push(statement.name.text);
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const el of statement.exportClause.elements) names.push(el.name.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamespaceExport(statement.exportClause)
    ) {
      names.push(statement.exportClause.name.text);
    } else if (ts.isExportAssignment(statement)) {
      names.push("default");
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const { left, right } = statement.expression;
      if (
        ts.isPropertyAccessExpression(left) &&
        left.expression.getText(sf) === "module" &&
        left.name.text === "exports"
      ) {
        if (ts.isObjectLiteralExpression(right)) {
          for (const prop of right.properties) {
            if (
              (ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop)) &&
              ts.isIdentifier(prop.name)
            ) {
              names.push(prop.name.text);
            }
          }
        } else {
          names.push("default");
        }
      } else if (
        ts.isPropertyAccessExpression(left) &&
        left.expression.getText(sf).match(/^(module\.)?exports$/)
      ) {
        names.push(left.name.text);
      }
    }
  }
  return [...new Set(names)];
}
