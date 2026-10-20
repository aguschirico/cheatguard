import { describe, expect, test } from "vitest";
import { configTampering } from "../../src/rules/config-tampering.js";
import { run } from "../helpers/rules.js";

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      noImplicitAny: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: false,
    },
    include: ["src"],
    exclude: ["dist"],
  },
  null,
  2,
);
const tsconfig = (
  mutate: (c: {
    compilerOptions: Record<string, unknown>;
    include: string[];
    exclude: string[];
  }) => void,
): string => {
  const c = JSON.parse(TSCONFIG);
  mutate(c);
  return JSON.stringify(c, null, 2);
};
const PKG = JSON.stringify(
  {
    name: "x",
    scripts: {
      test: "vitest run",
      lint: "biome check .",
      typecheck: "tsc --noEmit",
      build: "tsup",
    },
  },
  null,
  2,
);
const pkg = (scripts: Record<string, string>): string =>
  JSON.stringify({ name: "x", scripts }, null, 2);
const VITEST = `import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist"],
    coverage: { thresholds: { lines: 80, branches: 70 } },
  },
});
`;
const ESLINT_FLAT = `export default [{ rules: { "no-console": "error", eqeqeq: ["error", "always"] } }];\n`;
const ESLINTRC = JSON.stringify(
  { rules: { "no-unused-vars": "error", "@typescript-eslint/no-explicit-any": 2 } },
  null,
  2,
);
const BIOME = JSON.stringify(
  {
    linter: { enabled: true, rules: { recommended: true, suspicious: { noExplicitAny: "error" } } },
  },
  null,
  2,
);

describe("config-tampering: positives", () => {
  test.each([
    [
      "strict turned off",
      "tsconfig.json",
      TSCONFIG,
      tsconfig((c) => {
        c.compilerOptions.strict = false;
      }),
      "strict",
    ],
    [
      "strict flag removed",
      "tsconfig.json",
      TSCONFIG,
      tsconfig((c) => {
        delete c.compilerOptions.noImplicitAny;
      }),
      "noImplicitAny",
    ],
    [
      "file excluded from type checking",
      "tsconfig.json",
      TSCONFIG,
      tsconfig((c) => {
        c.exclude.push("src/broken.ts");
      }),
      "exclude",
    ],
    [
      "include narrowed",
      "tsconfig.build.json",
      TSCONFIG,
      tsconfig((c) => {
        c.include = ["src/ok"];
      }),
      "include",
    ],
    [
      "test script neutralized",
      "package.json",
      PKG,
      pkg({
        test: "vitest run || true",
        lint: "biome check .",
        typecheck: "tsc --noEmit",
        build: "tsup",
      }),
      "test",
    ],
    [
      "lint script removed",
      "package.json",
      PKG,
      pkg({ test: "vitest run", typecheck: "tsc --noEmit", build: "tsup" }),
      "lint",
    ],
    [
      "typecheck script replaced by echo",
      "package.json",
      PKG,
      pkg({ test: "vitest run", lint: "biome check .", typecheck: "echo ok", build: "tsup" }),
      "typecheck",
    ],
    [
      "coverage threshold lowered",
      "vitest.config.ts",
      VITEST,
      VITEST.replace("lines: 80", "lines: 0"),
      "thresholds.lines",
    ],
    [
      "passWithNoTests enabled",
      "vitest.config.ts",
      VITEST,
      VITEST.replace("include:", "passWithNoTests: true,\n    include:"),
      "passWithNoTests",
    ],
    [
      "tests excluded",
      "vitest.config.ts",
      VITEST,
      VITEST.replace(`exclude: ["dist"]`, `exclude: ["dist", "src/auth.test.ts"]`),
      "exclude",
    ],
    [
      "eslint flat rule turned off",
      "eslint.config.js",
      ESLINT_FLAT,
      ESLINT_FLAT.replace(`"no-console": "error"`, `"no-console": "off"`),
      "no-console",
    ],
    [
      "eslintrc rule downgraded to warn",
      ".eslintrc.json",
      ESLINTRC,
      ESLINTRC.replace(`"no-unused-vars": "error"`, `"no-unused-vars": "warn"`),
      "no-unused-vars",
    ],
    [
      "eslintrc numeric severity lowered",
      ".eslintrc.json",
      ESLINTRC,
      ESLINTRC.replace(`: 2`, `: 0`),
      "no-explicit-any",
    ],
    [
      "biome rule turned off",
      "biome.json",
      BIOME,
      BIOME.replace(`"noExplicitAny": "error"`, `"noExplicitAny": "off"`),
      "noExplicitAny",
    ],
    [
      "biome recommended disabled",
      "biome.json",
      BIOME,
      BIOME.replace(`"recommended": true`, `"recommended": false`),
      "recommended",
    ],
    [
      "biome linter disabled",
      "biome.json",
      BIOME,
      BIOME.replace(`"enabled": true`, `"enabled": false`),
      "enabled",
    ],
  ])("blocks %s", (_name, path, before, after, needle) => {
    const vs = run(configTampering, [{ path, before, after }]);
    expect(vs.length).toBeGreaterThanOrEqual(1);
    expect(vs.every((v) => v.severity === "block")).toBe(true);
    expect(vs.map((v) => v.detail).join("\n")).toContain(needle);
  });

  test("any change to cheatguard.config.json is blocked", () => {
    const vs = run(configTampering, [
      { path: "cheatguard.config.json", before: "{}", after: `{"rules":{"test-weakened":"off"}}` },
    ]);
    expect(vs.map((v) => v.severity)).toEqual(["block"]);
  });

  test("creating cheatguard.config.json during a change is blocked", () => {
    expect(
      run(configTampering, [
        { path: "cheatguard.config.json", after: `{"rules":{"stub-left":"off"}}` },
      ]),
    ).toHaveLength(1);
  });

  test("skipLibCheck enabled is a warning", () => {
    const vs = run(configTampering, [
      {
        path: "tsconfig.json",
        before: TSCONFIG,
        after: tsconfig((c) => {
          c.compilerOptions.skipLibCheck = true;
        }),
      },
    ]);
    expect(vs.map((v) => v.severity)).toEqual(["warn"]);
  });

  test("tsconfig with comments is understood", () => {
    const before = `{\n  // strict mode\n  "compilerOptions": { "strict": true }\n}\n`;
    const after = `{\n  // strict mode\n  "compilerOptions": { "strict": false }\n}\n`;
    expect(run(configTampering, [{ path: "tsconfig.json", before, after }])).toHaveLength(1);
  });

  test("a new eslint ignore pattern is blocked", () => {
    const before = `export default [{ rules: { eqeqeq: "error" } }];\n`;
    const after = `export default [{ ignores: ["src/legacy/**"] }, { rules: { eqeqeq: "error" } }];\n`;
    expect(run(configTampering, [{ path: "eslint.config.mjs", before, after }])).toHaveLength(1);
  });
});

describe("config-tampering: negatives", () => {
  test.each([
    [
      "strictness increased",
      "tsconfig.json",
      TSCONFIG,
      tsconfig((c) => {
        c.compilerOptions.exactOptionalPropertyTypes = true;
      }),
    ],
    ["formatting only", "tsconfig.json", TSCONFIG, JSON.stringify(JSON.parse(TSCONFIG))],
    [
      "new build-only script",
      "package.json",
      PKG,
      pkg({
        test: "vitest run",
        lint: "biome check .",
        typecheck: "tsc --noEmit",
        build: "tsup",
        dev: "tsup --watch",
      }),
    ],
    [
      "dependency added",
      "package.json",
      PKG,
      JSON.stringify({ ...JSON.parse(PKG), dependencies: { zod: "3" } }),
    ],
    [
      "coverage threshold raised",
      "vitest.config.ts",
      VITEST,
      VITEST.replace("lines: 80", "lines: 90"),
    ],
    [
      "tests included more broadly",
      "vitest.config.ts",
      VITEST,
      VITEST.replace(
        `include: ["src/**/*.test.ts"]`,
        `include: ["src/**/*.test.ts", "test/**/*.test.ts"]`,
      ),
    ],
    [
      "eslint rule made stricter",
      "eslint.config.js",
      ESLINT_FLAT,
      ESLINT_FLAT.replace(
        `eqeqeq: ["error", "always"]`,
        `eqeqeq: ["error", "always"], "no-var": "error"`,
      ),
    ],
    [
      "biome rule enabled",
      "biome.json",
      BIOME,
      BIOME.replace(`"noExplicitAny": "error"`, `"noExplicitAny": "error", "noDebugger": "error"`),
    ],
    [
      "unrelated config file",
      "tsup.config.ts",
      `export default { entry: ["a.ts"] };\n`,
      `export default { entry: ["a.ts", "b.ts"] };\n`,
    ],
    ["new tsconfig with strict on", "tsconfig.node.json", null, TSCONFIG],
    [
      "check script runs one more file through the same check",
      "package.json",
      pkg({ test: "vitest run", check: "node --check a.mjs && node --check b.mjs" }),
      pkg({
        test: "vitest run",
        check: "node --check a.mjs && node --check c.mjs && node --check b.mjs",
      }),
    ],
    [
      "package-manager prefix dropped from a check",
      "package.json",
      pkg({ test: "yarn jest", typecheck: "yarn tsc --noEmit" }),
      pkg({ test: "jest", typecheck: "tsc --noEmit" }),
    ],
  ])("accepts %s", (_name, path, before, after) => {
    expect(run(configTampering, [{ path, before, after }])).toEqual([]);
  });

  test("a gate script that gains a different command is still a warning", () => {
    // `rm -rf test` runs before the tests: adding commands is not always harmless.
    const vs = run(configTampering, [
      {
        path: "package.json",
        before: pkg({ test: "vitest run" }),
        after: pkg({ test: "rm -rf test && vitest run" }),
      },
    ]);
    expect(vs.map((v) => v.severity)).toEqual(["warn"]);
  });

  test("a check that gains a run of the same tool with only flags is still a warning", () => {
    // `jest -u` rewrites the snapshots before the real run: same tool, not the same check.
    const vs = run(configTampering, [
      {
        path: "package.json",
        before: pkg({ test: "jest src" }),
        after: pkg({ test: "jest -u && jest src" }),
      },
    ]);
    expect(vs.map((v) => v.severity)).toEqual(["warn"]);
  });

  test.each([
    ["a script before a one-word check", "vitest", "./delete-tests.sh && vitest"],
    ["another shell script through sh", "sh -e check.sh", "sh -e other.sh && sh -e check.sh"],
    [
      "another file run through node",
      "node --import tsx a.ts",
      "node --import tsx b.ts && node --import tsx a.ts",
    ],
    [
      "another file removed",
      "rm -f out.log && vitest run",
      "rm -f test/a.test.ts && rm -f out.log && vitest run",
    ],
  ])("a gate that gains %s is still a warning", (_name, was, now) => {
    const vs = run(configTampering, [
      { path: "package.json", before: pkg({ test: was }), after: pkg({ test: now }) },
    ]);
    expect(vs.map((v) => v.severity)).toEqual(["warn"]);
  });

  test.each([["vitest run\nexit 0"], ["vitest run\ntrue"], ["vitest run\r\n:"]])(
    "a command added on a new line is judged like `;` (%j)",
    (now) => {
      const vs = run(configTampering, [
        { path: "package.json", before: pkg({ test: "vitest run" }), after: pkg({ test: now }) },
      ]);
      expect(vs.map((v) => v.severity)).toEqual(["block"]);
    },
  );

  test("a package-manager prefix added to a check is still a warning", () => {
    // `yarn tsc` runs a package script named "tsc" when there is one.
    const vs = run(configTampering, [
      {
        path: "package.json",
        before: pkg({ typecheck: "tsc --noEmit" }),
        after: pkg({ typecheck: "yarn tsc --noEmit" }),
      },
    ]);
    expect(vs.map((v) => v.severity)).toEqual(["warn"]);
  });

  test("ordinary source files are ignored", () => {
    expect(
      run(configTampering, [
        {
          path: "src/config.ts",
          before: `export const strict = true;\n`,
          after: `export const strict = false;\n`,
        },
      ]),
    ).toEqual([]);
  });
});
