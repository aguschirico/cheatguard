import ts from "typescript";
import { lineOf } from "./parse.js";

export interface CommentToken {
  pos: number;
  line: number;
  /** Comment content without the comment markers. */
  body: string;
}

function stripMarkers(raw: string): string {
  if (raw.startsWith("//")) return raw.slice(2).trim();
  return raw
    .replace(/^\/\*+/, "")
    .replace(/\*+\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, ""))
    .join("\n")
    .trim();
}

/**
 * Every comment in the file, found as leading or trailing trivia of real tokens (never inside
 * strings or regexes). Trailing trivia matters: `return 1; // TODO` and `run(); //
 * eslint-disable-line` are not leading trivia of any token.
 */
export function collectComments(sf: ts.SourceFile): CommentToken[] {
  const seen = new Set<number>();
  const comments: CommentToken[] = [];
  // JSX text is not trivia: `<p>// see docs</p>` must not be read as a comment.
  const jsxText: Array<[number, number]> = [];
  const text = sf.text;
  const add = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      comments.push({
        pos: range.pos,
        line: lineOf(sf, range.pos),
        body: stripMarkers(text.slice(range.pos, range.end)),
      });
    }
  };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.pos, node.end]);
    else {
      add(ts.getLeadingCommentRanges(text, node.pos));
      add(ts.getTrailingCommentRanges(text, node.end));
    }
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return comments
    .filter((c) => !jsxText.some(([pos, end]) => c.pos >= pos && c.pos < end))
    .sort((a, b) => a.pos - b.pos);
}
