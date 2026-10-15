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

/** Every comment in the file, found as leading trivia of real tokens (never inside strings or regexes). */
export function collectComments(sf: ts.SourceFile): CommentToken[] {
  const seen = new Set<number>();
  const comments: CommentToken[] = [];
  const text = sf.text;
  const visit = (node: ts.Node): void => {
    if (node.kind !== ts.SyntaxKind.JsxText) {
      for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
        if (seen.has(range.pos)) continue;
        seen.add(range.pos);
        comments.push({
          pos: range.pos,
          line: lineOf(sf, range.pos),
          body: stripMarkers(text.slice(range.pos, range.end)),
        });
      }
    }
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return comments.sort((a, b) => a.pos - b.pos);
}
