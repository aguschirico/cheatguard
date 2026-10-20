import type { TodoComment } from "../adapter.js";
import type { CommentToken } from "./comments.js";

const MARKER_RE = /\b(TODO|FIXME|XXX|HACK)\b/;
const IMPLEMENT_RE =
  /\b(not\s+(yet\s+)?implemented|implement\s+(me|this|later)|fill\s+(this\s+)?in|placeholder\s+(implementation|logic|code)|stub(bed)?\s+(implementation|for\s+now|out)|temporary\s+stub)\b/i;

export function extractTodos(comments: readonly CommentToken[]): TodoComment[] {
  const todos: TodoComment[] = [];
  for (const comment of comments) {
    // A marker inside `inline code` is a mention (docs quoting an example), not a pending task.
    const prose = comment.body.replace(/`[^`\n]*`/g, "");
    const marker = MARKER_RE.test(prose);
    const implementPhrase = IMPLEMENT_RE.test(prose);
    if (!marker && !implementPhrase) continue;
    todos.push({
      line: comment.line,
      text: comment.body.split("\n")[0] ?? "",
      implement: implementPhrase || (marker && /\bimplement/i.test(prose)),
    });
  }
  return todos;
}
