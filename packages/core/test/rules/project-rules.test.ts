import { describe, expect, test } from "vitest";
import {
  duplicateExport,
  normalizeFunctionName,
  similarity,
} from "../../src/rules/duplicate-export.js";
import { scopeCreep } from "../../src/rules/scope-creep.js";
import { run } from "../helpers/rules.js";

const DATE_LIB = `export function formatDate(date: Date, locale: string): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return locale === "us" ? \`\${month}/\${day}/\${year}\` : \`\${day}/\${month}/\${year}\`;
}
`;
const files = { "src/lib/date.ts": DATE_LIB, "package.json": "{}" };

describe("normalizeFunctionName", () => {
  test("strips digits, case, separators and copy-style suffixes", () => {
    expect(normalizeFunctionName("formatDate2")).toBe("formatdate");
    expect(normalizeFunctionName("format_date")).toBe("formatdate");
    expect(normalizeFunctionName("formatDateNew")).toBe("formatdate");
    expect(normalizeFunctionName("formatDateV2")).toBe("formatdate");
    expect(normalizeFunctionName("formatDateCopy")).toBe("formatdate");
    expect(normalizeFunctionName("parse")).toBe("parse");
  });
});

describe("similarity", () => {
  test("is 1 for identical token streams and low for unrelated ones", () => {
    const a = ["a", "=", "b", "+", "c", ";", "return", "a", ";"];
    expect(similarity(a, a)).toBe(1);
    expect(similarity(a, ["x", "(", ")", ".", "then", "(", "y", ")", ";"])).toBeLessThan(0.2);
  });
});

describe("duplicate-export: positives", () => {
  test("warns on a near-identical name of an existing export", () => {
    const vs = run(
      duplicateExport,
      [
        {
          path: "src/utils/formatDate2.ts",
          after: `export function formatDate2(d: Date): string {\n  return d.toISOString();\n}\n`,
        },
      ],
      { files },
    );
    expect(vs).toHaveLength(1);
    expect(vs[0]?.severity).toBe("warn");
    expect(vs[0]?.detail).toContain("src/lib/date.ts");
    expect(vs[0]?.fix).toContain("formatDate");
  });

  test("warns on a copied body under a different name", () => {
    const copy = DATE_LIB.replace("formatDate", "renderDay");
    const vs = run(duplicateExport, [{ path: "src/ui/day.ts", after: copy }], { files });
    expect(vs).toHaveLength(1);
    expect(vs[0]?.detail).toContain("formatDate");
  });

  test("warns on a duplicate added to the same file", () => {
    const after = `${DATE_LIB}export const formatDateNew = (date: Date) => date.toLocaleDateString();\n`;
    expect(
      run(duplicateExport, [{ path: "src/lib/date.ts", before: DATE_LIB, after }], { files }),
    ).toHaveLength(1);
  });
});

describe("duplicate-export: negatives", () => {
  test("a non-exported helper is fine", () => {
    expect(
      run(
        duplicateExport,
        [
          {
            path: "src/a.ts",
            after: `function formatDate2(d: Date) { return d.toISOString(); }\nexport const x = formatDate2;\n`,
          },
        ],
        { files },
      ),
    ).toEqual([]);
  });

  test("an unrelated new export is fine", () => {
    expect(
      run(
        duplicateExport,
        [
          {
            path: "src/a.ts",
            after: `export function sum(a: number, b: number) { return a + b; }\n`,
          },
        ],
        { files },
      ),
    ).toEqual([]);
  });

  test("a function moved to another file is fine", () => {
    const vs = run(
      duplicateExport,
      [
        { path: "src/lib/date.ts", before: DATE_LIB, after: null },
        { path: "src/format/date.ts", after: DATE_LIB },
      ],
      { files: { "package.json": "{}" } },
    );
    expect(vs).toEqual([]);
  });

  test("the same common name in an unrelated module is fine", () => {
    const vs = run(
      duplicateExport,
      [
        {
          path: "src/other.ts",
          after: `export function parse(s: string) { return s.split(","); }\n`,
        },
      ],
      {
        files: {
          "src/json.ts": `export function parse(s: string) { return JSON.parse(s) as unknown; }\n`,
        },
      },
    );
    expect(vs).toEqual([]);
  });

  test("an existing export that was only edited is not new", () => {
    const after = DATE_LIB.replace(`"us"`, `"en-US"`);
    expect(
      run(duplicateExport, [{ path: "src/lib/date.ts", before: DATE_LIB, after }], { files }),
    ).toEqual([]);
  });

  test("test files are ignored", () => {
    expect(
      run(
        duplicateExport,
        [{ path: "src/lib/date.test.ts", after: DATE_LIB.replace("formatDate", "formatDate2") }],
        { files },
      ),
    ).toEqual([]);
  });
});

describe("scope-creep", () => {
  const config = { scope: { allow: ["src/auth/**", "test/auth/**"] } };

  test("warns on files changed outside the allowed scope", () => {
    const vs = run(
      scopeCreep,
      [
        { path: "src/auth/login.ts", before: "a", after: "b" },
        { path: "src/billing/invoice.ts", before: "a", after: "b" },
      ],
      { config },
    );
    expect(vs.map((v) => [v.file, v.severity])).toEqual([["src/billing/invoice.ts", "warn"]]);
  });

  test("covers deleted and non-code files too", () => {
    const vs = run(scopeCreep, [{ path: "docs/x.md", before: "a", after: null }], { config });
    expect(vs).toHaveLength(1);
  });

  test("does nothing without a configured scope", () => {
    expect(run(scopeCreep, [{ path: "anywhere.ts", before: "a", after: "b" }])).toEqual([]);
  });
});
