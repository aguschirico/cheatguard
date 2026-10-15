import ts from "typescript";
import { normalizeText } from "../adapter.js";

export function scriptKindFor(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface WithParseDiagnostics {
  parseDiagnostics?: readonly ts.Diagnostic[];
}

export interface Parsed {
  sf: ts.SourceFile;
  error: { line: number; message: string } | null;
}

export function parseSource(path: string, text: string): Parsed {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  // parseDiagnostics is not part of the public typings but is always present on parsed files.
  const withDiagnostics: ts.SourceFile & WithParseDiagnostics = sf;
  const diagnostics = withDiagnostics.parseDiagnostics ?? [];
  const first = diagnostics[0];
  if (!first) return { sf, error: null };
  const line = first.start === undefined ? 1 : lineOf(sf, first.start);
  return { sf, error: { line, message: ts.flattenDiagnosticMessageText(first.messageText, " ") } };
}

export function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

export function startLine(sf: ts.SourceFile, node: ts.Node): number {
  return lineOf(sf, node.getStart(sf));
}

export function lineText(sf: ts.SourceFile, line: number): string {
  const starts = sf.getLineStarts();
  const start = starts[line - 1];
  if (start === undefined) return "";
  const end = starts[line] ?? sf.text.length;
  return normalizeText(sf.text.slice(start, end));
}

export function textOf(sf: ts.SourceFile, node: ts.Node): string {
  return normalizeText(node.getText(sf));
}
