import type { AnalyzeResult, LanguageAdapter } from "../adapter.js";
import { extractCatches } from "./catches.js";
import { collectComments } from "./comments.js";
import { extractExports } from "./exports.js";
import { extractFunctions } from "./functions.js";
import { extractImports } from "./imports.js";
import { extractLiterals, isConfigLikePath } from "./literals.js";
import { parseSource } from "./parse.js";
import { extractSuppressions } from "./suppressions.js";
import { extractMocks, extractTests } from "./tests.js";
import { extractTodos } from "./todos.js";

const SUPPORTED_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

export { isConfigLikePath } from "./literals.js";

export const typescriptAdapter: LanguageAdapter = {
  id: "typescript",
  supports(path: string): boolean {
    return SUPPORTED_RE.test(path);
  },
  analyze(path: string, text: string): AnalyzeResult {
    const { sf, error } = parseSource(path, text);
    if (error) return { ok: false, line: error.line, message: error.message };
    const comments = collectComments(sf);
    const { functions, notImplemented } = extractFunctions(sf);
    return {
      ok: true,
      facts: {
        tests: extractTests(sf),
        mocks: extractMocks(sf),
        suppressions: extractSuppressions(sf, comments),
        imports: extractImports(sf),
        exports: extractExports(sf),
        catches: extractCatches(sf),
        functions,
        notImplemented,
        todos: extractTodos(comments),
        literals: isConfigLikePath(path) ? extractLiterals(sf) : [],
      },
    };
  },
};
