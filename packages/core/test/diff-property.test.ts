import fc from "fast-check";
import { expect, test } from "vitest";
import { computeAddedLines } from "../src/changes.js";

function lcsLength(a: readonly string[], b: readonly string[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const row = dp[i] as number[];
      const prev = dp[i - 1] as number[];
      row[j] =
        a[i - 1] === b[j - 1]
          ? (prev[j - 1] as number) + 1
          : Math.max(prev[j] as number, row[j - 1] as number);
    }
  }
  return (dp[a.length] as number[])[b.length] as number;
}

const toText = (lines: readonly string[]): string => (lines.length ? `${lines.join("\n")}\n` : "");
const linesArb = fc.array(fc.constantFrom("a", "b", "c", "d", "e"), { maxLength: 30 });

test("added lines = |after| - LCS and the kept lines form a subsequence of before", () => {
  fc.assert(
    fc.property(linesArb, linesArb, (before, after) => {
      const added = computeAddedLines(toText(before), toText(after));
      expect(added.size).toBe(after.length - lcsLength(before, after));
      const kept = after.filter((_, i) => !added.has(i + 1));
      let j = 0;
      for (const line of before) if (j < kept.length && kept[j] === line) j += 1;
      expect(j).toBe(kept.length);
    }),
    { numRuns: 2000 },
  );
});
