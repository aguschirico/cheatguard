import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { check, checkFile } from "../src/engine.js";
import { createTempRepo } from "./helpers/repo.js";

const FACTOR = Number(process.env.CHEATGUARD_PERF_FACTOR ?? "1");

function bigFile(lines: number): string {
  const out: string[] = [];
  for (let i = 0; out.length < lines; i += 1) {
    out.push(
      `export function fn${i}(input: number): number {`,
      `  const doubled = input * 2;`,
      `  if (doubled > ${i}) return doubled - ${i};`,
      `  return doubled + 1;`,
      "}",
      "",
    );
  }
  return `${out.join("\n")}\n`;
}

describe("performance budgets", () => {
  test("single-file edit check stays under 300 ms on a 2,000-line file", () => {
    const content = bigFile(2000);
    const repo = createTempRepo({ "package.json": "{}", "src/big.ts": content });
    repo.write(
      "src/big.ts",
      content.replace("const doubled = input * 2;", "const doubled = (input as any) * 2;"),
    );
    const base = repo.git("rev-parse", "HEAD^{tree}").trim();
    checkFile({ root: repo.root, baseTree: base, path: "src/big.ts", config: DEFAULT_CONFIG }); // warm-up (module + parser JIT)
    const start = performance.now();
    const result = checkFile({
      root: repo.root,
      baseTree: base,
      path: "src/big.ts",
      config: DEFAULT_CONFIG,
    });
    const elapsed = performance.now() - start;
    expect(result.violations.map((v) => v.rule)).toEqual(["type-suppression"]);
    expect(elapsed).toBeLessThan(300 * FACTOR);
  });

  test("full check stays under 3 s on a 500-file repository", () => {
    const files: Record<string, string> = { "package.json": "{}" };
    for (let i = 0; i < 500; i += 1)
      files[`src/mod${i}.ts`] = bigFile(60).replace(/fn(\d+)/g, `m${i}_fn$1`);
    const repo = createTempRepo(files);
    for (let i = 0; i < 20; i += 1)
      repo.write(`src/mod${i}.ts`, `${files[`src/mod${i}.ts`]}export const extra${i} = ${i};\n`);
    const start = performance.now();
    const result = check({
      root: repo.root,
      base: "HEAD",
      head: "worktree",
      config: DEFAULT_CONFIG,
    });
    const elapsed = performance.now() - start;
    expect(result.filesAnalyzed).toBe(20);
    expect(elapsed).toBeLessThan(3000 * FACTOR);
  }, 60_000);
});
