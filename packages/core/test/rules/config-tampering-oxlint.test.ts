import { describe, expect, test } from "vitest";
import { configKindOf } from "../../src/config-kind.js";
import { configTampering } from "../../src/rules/config-tampering.js";
import { run } from "../helpers/rules.js";

const OXLINTRC = JSON.stringify(
  {
    plugins: ["typescript", "unicorn", "oxc", "import"],
    categories: { correctness: "error", suspicious: "warn" },
    rules: { "no-debugger": "error", eqeqeq: ["deny", "always"], "typescript/no-explicit-any": 2 },
    ignorePatterns: ["dist/**"],
    overrides: [{ files: ["src/**/*.ts"], rules: { "no-console": "error" } }],
    extends: ["./base.oxlintrc.json"],
  },
  null,
  2,
);
const edit = (mutate: (c: Record<string, unknown>) => void): string => {
  const c = JSON.parse(OXLINTRC);
  mutate(c);
  return JSON.stringify(c, null, 2);
};
const OXLINT_TS = `import { defineConfig } from "oxlint";
export default defineConfig({
  categories: { correctness: "error" },
  rules: { "no-debugger": "error" },
});
`;
const FILES = { "src/a.ts": "", "src/b.ts": "", "src/legacy/c.ts": "" };

describe("oxlint config files", () => {
  test.each([
    [".oxlintrc.json", "oxlint"],
    ["packages/web/.oxlintrc.json", "oxlint"],
    ["oxlint.config.ts", "oxlint"],
    ["oxlint.config.mjs", "oxlint"],
    ["oxlintrc.json", null],
  ])("%s is %s", (path, kind) => {
    expect(configKindOf(path)).toBe(kind);
  });
});

describe("config-tampering: oxlint positives", () => {
  test.each([
    [
      "rule turned off",
      edit((c) => Reflect.set(c, "rules", { ...rules(c), "no-debugger": "off" })),
      "no-debugger",
    ],
    [
      "rule allowed",
      edit((c) => Reflect.set(c, "rules", { ...rules(c), "no-debugger": "allow" })),
      "no-debugger",
    ],
    [
      "rule downgraded to warn",
      edit((c) => Reflect.set(c, "rules", { ...rules(c), "no-debugger": "warn" })),
      "no-debugger",
    ],
    [
      "rule with options downgraded",
      edit((c) => Reflect.set(c, "rules", { ...rules(c), eqeqeq: ["warn", "always"] })),
      "eqeqeq",
    ],
    [
      "numeric severity lowered",
      edit((c) => Reflect.set(c, "rules", { ...rules(c), "typescript/no-explicit-any": 0 })),
      "no-explicit-any",
    ],
    [
      "new rule turned off",
      edit((c) => Reflect.set(c, "rules", { ...rules(c), "no-unused-vars": "off" })),
      "no-unused-vars",
    ],
    [
      "override rule turned off",
      edit((c) =>
        Reflect.set(c, "overrides", [{ files: ["src/**/*.ts"], rules: { "no-console": "off" } }]),
      ),
      "no-console",
    ],
    [
      "category turned off",
      edit((c) => Reflect.set(c, "categories", { correctness: "off", suspicious: "warn" })),
      "correctness",
    ],
    [
      "category downgraded",
      edit((c) => Reflect.set(c, "categories", { correctness: "warn", suspicious: "warn" })),
      "correctness",
    ],
    [
      "new category turned off",
      edit((c) =>
        Reflect.set(c, "categories", { correctness: "error", suspicious: "warn", perf: "off" }),
      ),
      "perf",
    ],
    [
      "path ignored",
      edit((c) => Reflect.set(c, "ignorePatterns", ["dist/**", "src/legacy/**"])),
      "src/legacy/**",
    ],
    [
      "plugin removed",
      edit((c) => Reflect.set(c, "plugins", ["typescript", "unicorn", "oxc"])),
      "import",
    ],
    ["extends removed", edit((c) => Reflect.deleteProperty(c, "extends")), "base.oxlintrc.json"],
    [
      "override files narrowed",
      edit((c) =>
        Reflect.set(c, "overrides", [{ files: ["src/a.ts"], rules: { "no-console": "error" } }]),
      ),
      "overrides[].files",
    ],
  ])("blocks %s", (_name, after, mentions) => {
    const vs = run(configTampering, [{ path: ".oxlintrc.json", before: OXLINTRC, after }], {
      files: FILES,
    });
    expect(vs.length).toBeGreaterThan(0);
    expect(vs.every((v) => v.severity === "block")).toBe(true);
    expect(vs.map((v) => v.detail).join("\n")).toContain(mentions);
  });

  test("setting plugins for the first time drops oxlint's default plugins it leaves out", () => {
    const before = JSON.stringify({ rules: { "no-debugger": "error" } }, null, 2);
    const after = JSON.stringify(
      { plugins: ["import"], rules: { "no-debugger": "error" } },
      null,
      2,
    );
    const vs = run(configTampering, [{ path: ".oxlintrc.json", before, after }]);
    expect(vs.map((v) => v.detail).join("\n")).toMatch(/typescript.*unicorn.*oxc|default plugins/);
  });

  test("a new nested config is compared against nothing: only explicit relaxations", () => {
    const after = JSON.stringify({ rules: { "no-debugger": "off", eqeqeq: "error" } }, null, 2);
    const vs = run(configTampering, [{ path: "src/legacy/.oxlintrc.json", before: null, after }]);
    expect(vs.map((v) => v.detail)).toEqual(['oxlint rule "no-debugger" was turned off']);
  });

  test("oxlint.config.ts: a rule turned off", () => {
    const vs = run(configTampering, [
      {
        path: "oxlint.config.ts",
        before: OXLINT_TS,
        after: OXLINT_TS.replace(`"no-debugger": "error"`, `"no-debugger": "off"`),
      },
    ]);
    expect(vs.map((v) => v.detail)).toEqual([
      'oxlint rule "no-debugger" was weakened: error → off',
    ]);
  });

  test("deleting the config is blocked", () => {
    const vs = run(configTampering, [{ path: ".oxlintrc.json", before: OXLINTRC, after: null }]);
    expect(vs[0]?.detail).toBe(".oxlintrc.json was deleted");
  });
});

describe("config-tampering: oxlint negatives", () => {
  test.each([
    [
      "rule made stricter",
      edit((c) => Reflect.set(c, "rules", { ...rules(c), "no-debugger": "deny" })),
    ],
    ["new rule enabled", edit((c) => Reflect.set(c, "rules", { ...rules(c), "no-var": "error" }))],
    [
      "category raised",
      edit((c) => Reflect.set(c, "categories", { correctness: "error", suspicious: "error" })),
    ],
    [
      "plugin added",
      edit((c) => Reflect.set(c, "plugins", ["typescript", "unicorn", "oxc", "import", "jest"])),
    ],
    ["ignore pattern removed", edit((c) => Reflect.set(c, "ignorePatterns", []))],
    [
      "override files widened",
      edit((c) =>
        Reflect.set(c, "overrides", [
          { files: ["src/**/*.ts", "test/**/*.ts"], rules: { "no-console": "error" } },
        ]),
      ),
    ],
  ])("accepts %s", (_name, after) => {
    expect(
      run(configTampering, [{ path: ".oxlintrc.json", before: OXLINTRC, after }], { files: FILES }),
    ).toEqual([]);
  });

  test("setting plugins for the first time while keeping the defaults is fine", () => {
    const before = JSON.stringify({ rules: { "no-debugger": "error" } }, null, 2);
    const after = JSON.stringify(
      { plugins: ["typescript", "unicorn", "oxc", "import"], rules: { "no-debugger": "error" } },
      null,
      2,
    );
    expect(run(configTampering, [{ path: ".oxlintrc.json", before, after }])).toEqual([]);
  });
});

function rules(c: Record<string, unknown>): Record<string, unknown> {
  const value = c.rules;
  return typeof value === "object" && value !== null ? { ...value } : {};
}
