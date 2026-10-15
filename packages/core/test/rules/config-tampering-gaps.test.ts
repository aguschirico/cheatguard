import { describe, expect, test } from "vitest";
import { configTampering } from "../../src/rules/config-tampering.js";
import { run } from "../helpers/rules.js";

// Repros from the adversarial review: static relaxations that passed or only warned.
const TESTS = {
  "src/sum.test.ts": `test("x", () => {});\n`,
  "src/math/div.test.ts": `test("y", () => {});\n`,
  "src/sum.ts": "export const sum = 1;\n",
};
const blocks = (vs: ReturnType<typeof run>) => vs.filter((v) => v.severity === "block");
const pkg = (test: string): string => JSON.stringify({ name: "x", scripts: { test } }, null, 2);

describe("config-tampering: neutralized scripts", () => {
  test.each([
    ["vitest run; true"],
    ["vitest run || echo skipped"],
    ["vitest run & exit 0"],
    ["node -e 0"],
    ["vitest run --exclude src/sum.test.ts"],
    ["vitest run -t 'adds'"],
    ["vitest run --testNamePattern adds"],
    ["jest --testPathIgnorePatterns sum"],
  ])('"vitest run" → "%s" is blocked', (now) => {
    const vs = run(configTampering, [
      { path: "package.json", before: pkg("vitest run"), after: pkg(now) },
    ]);
    expect(blocks(vs)).toHaveLength(1);
  });

  test.each([["vitest run --reporter=dot"], ["vitest run --coverage"], ["pnpm vitest run"]])(
    '"vitest run" → "%s" only warns',
    (now) => {
      const vs = run(configTampering, [
        { path: "package.json", before: pkg("vitest run"), after: pkg(now) },
      ]);
      expect(vs.map((v) => v.severity)).toEqual(["warn"]);
    },
  );

  test("a script that already chained commands may keep them", () => {
    const before = pkg("tsc --noEmit && vitest run");
    const after = pkg("tsc --noEmit && vitest run --reporter=dot");
    expect(blocks(run(configTampering, [{ path: "package.json", before, after }]))).toEqual([]);
  });
});

describe("config-tampering: test file sets", () => {
  const vitest = (include: string): string =>
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: [${include}] } });\n`;

  test("replacing include with a pattern that matches no existing test is blocked", () => {
    const vs = run(
      configTampering,
      [
        {
          path: "vitest.config.ts",
          before: vitest(`"src/**/*.test.ts"`),
          after: vitest(`"src/**/*.spec.ts"`),
        },
      ],
      { files: TESTS },
    );
    expect(blocks(vs)).toHaveLength(1);
    expect(vs[0]?.detail).toContain("src/sum.test.ts");
  });

  test("replacing include with an equivalent pattern is fine", () => {
    const vs = run(
      configTampering,
      [
        {
          path: "vitest.config.ts",
          before: vitest(`"src/**/*.test.ts"`),
          after: vitest(`"src/**/*.{test,spec}.ts"`),
        },
      ],
      { files: TESTS },
    );
    expect(vs).toEqual([]);
  });

  test("a narrower replacement that drops one directory is blocked", () => {
    const vs = run(
      configTampering,
      [
        {
          path: "vitest.config.ts",
          before: vitest(`"src/**/*.test.ts"`),
          after: vitest(`"src/*.test.ts"`),
        },
      ],
      { files: TESTS },
    );
    expect(blocks(vs)[0]?.detail).toContain("src/math/div.test.ts");
  });

  test.each([
    ["alias", `test: { alias: { "./sum": "./fake-sum" } }`],
    ["setupFiles", `test: { setupFiles: ["./mock-everything.ts"] }`],
    ["retry", `test: { retry: 50 }`],
  ])("vitest %s added warns", (_label, body) => {
    const before = `export default { test: {} };\n`;
    const after = `export default { ${body} };\n`;
    const vs = run(configTampering, [{ path: "vitest.config.ts", before, after }]);
    expect(vs.map((v) => v.severity)).toEqual(["warn"]);
  });

  test("playwright testIgnore added is blocked", () => {
    const before = `export default { testDir: "e2e" };\n`;
    const after = `export default { testDir: "e2e", testIgnore: ["**/checkout.spec.ts"] };\n`;
    expect(
      blocks(run(configTampering, [{ path: "playwright.config.ts", before, after }])),
    ).toHaveLength(1);
  });

  test("mocha spec narrowed is blocked", () => {
    const before = JSON.stringify({ spec: ["test/**/*.spec.js"] });
    const after = JSON.stringify({ spec: ["test/unit/**/*.spec.js"] });
    const vs = run(configTampering, [{ path: ".mocharc.json", before, after }], {
      files: { "test/unit/a.spec.js": "", "test/e2e/b.spec.js": "" },
    });
    expect(blocks(vs)).toHaveLength(1);
  });
});

describe("config-tampering: lint scope", () => {
  test("narrowing ESLint flat config files is blocked", () => {
    const before = `export default [{ files: ["src/**/*.ts"], rules: { eqeqeq: "error" } }];\n`;
    const after = `export default [{ files: ["nothing/**"], rules: { eqeqeq: "error" } }];\n`;
    expect(
      blocks(run(configTampering, [{ path: "eslint.config.js", before, after }], { files: TESTS })),
    ).toHaveLength(1);
  });

  test("lines added to .eslintignore are blocked", () => {
    const vs = run(configTampering, [
      { path: ".eslintignore", before: "dist\n", after: "dist\nsrc/\n" },
    ]);
    expect(blocks(vs)).toHaveLength(1);
    expect(vs[0]?.detail).toContain("src/");
  });

  test("narrowing Biome files.includes is blocked", () => {
    const before = JSON.stringify({ files: { includes: ["src/**", "test/**"] } });
    const after = JSON.stringify({ files: { includes: ["test/**"] } });
    expect(
      blocks(run(configTampering, [{ path: "biome.json", before, after }], { files: TESTS })),
    ).toHaveLength(1);
  });
});

describe("config-tampering: tsconfig files with other names", () => {
  const strict = JSON.stringify({ compilerOptions: { strict: true } }, null, 2);
  const loose = JSON.stringify({ compilerOptions: { strict: false } }, null, 2);

  test("tsconfig-base.json is a tsconfig", () => {
    expect(
      blocks(run(configTampering, [{ path: "tsconfig-base.json", before: strict, after: loose }])),
    ).toHaveLength(1);
  });

  test("a file reached through extends is a tsconfig", () => {
    const vs = run(
      configTampering,
      [{ path: "config/ts-base.json", before: strict, after: loose }],
      {
        files: { "tsconfig.json": JSON.stringify({ extends: "./config/ts-base.json" }) },
      },
    );
    expect(blocks(vs)).toHaveLength(1);
  });

  test("an extends chain is followed", () => {
    const vs = run(
      configTampering,
      [{ path: "config/strict.json", before: strict, after: loose }],
      {
        files: {
          "tsconfig.json": JSON.stringify({ extends: ["./config/base"] }),
          "config/base.json": JSON.stringify({ extends: "./strict.json" }),
        },
      },
    );
    expect(blocks(vs)).toHaveLength(1);
  });

  test("an unrelated JSON file is not a tsconfig", () => {
    expect(
      run(configTampering, [{ path: "data/strict.json", before: strict, after: loose }]),
    ).toEqual([]);
  });
});

describe("config-tampering: CI workflows", () => {
  const WF = `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
      - run: npm run lint
`;
  const P = ".github/workflows/ci.yml";
  test.each([
    ["|| true on a check", WF.replace("npm test", "npm test || true")],
    [
      "continue-on-error",
      WF.replace(
        "      - run: npm test\n",
        "      - run: npm test\n        continue-on-error: true\n",
      ),
    ],
    ["a removed check step", WF.replace("      - run: npm run lint\n", "")],
    ["if: false", WF.replace("  test:\n", "  test:\n    if: false\n")],
  ])("%s is blocked", (_label, after) => {
    expect(blocks(run(configTampering, [{ path: P, before: WF, after }]))).toHaveLength(1);
  });

  test("adding a step is fine", () => {
    const after = WF.replace(
      "      - run: npm run lint\n",
      "      - run: npm run lint\n      - run: npm run build\n",
    );
    expect(run(configTampering, [{ path: P, before: WF, after }])).toEqual([]);
  });
});

describe("config-tampering: the guard's own hooks", () => {
  const SETTINGS = JSON.stringify(
    {
      permissions: { allow: ["Bash(npm test:*)"] },
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write|MultiEdit",
            hooks: [{ type: "command", command: "npx cheatguard hook claude-code" }],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "npx cheatguard hook claude-code" }] }],
      },
    },
    null,
    2,
  );
  const P = ".claude/settings.json";

  test("removing the cheatguard hooks is blocked", () => {
    const vs = run(configTampering, [{ path: P, before: SETTINGS, after: "{}" }]);
    expect(blocks(vs).length).toBeGreaterThanOrEqual(1);
    expect(vs[0]?.detail).toContain("cheatguard");
  });

  test("changing a cheatguard hook matcher is blocked", () => {
    const after = SETTINGS.replace("Edit|Write|MultiEdit", "NeverMatches");
    expect(blocks(run(configTampering, [{ path: P, before: SETTINGS, after }]))).toHaveLength(1);
  });

  test("disableAllHooks in a new settings.local.json is blocked", () => {
    const vs = run(configTampering, [
      { path: ".claude/settings.local.json", after: JSON.stringify({ disableAllHooks: true }) },
    ]);
    expect(blocks(vs)).toHaveLength(1);
  });

  test("disabling the cheatguard plugin is blocked", () => {
    const before = JSON.stringify({ enabledPlugins: { "cheatguard@cheatguard": true } });
    const after = JSON.stringify({ enabledPlugins: { "cheatguard@cheatguard": false } });
    expect(blocks(run(configTampering, [{ path: P, before, after }]))).toHaveLength(1);
  });

  test("unrelated settings changes are fine", () => {
    const after = SETTINGS.replace("Bash(npm test:*)", "Bash(npm run build:*)");
    expect(run(configTampering, [{ path: P, before: SETTINGS, after }])).toEqual([]);
  });

  test("deleting a settings file without cheatguard hooks is fine", () => {
    const before = JSON.stringify({ permissions: { allow: [] } });
    expect(
      run(configTampering, [{ path: ".claude/settings.local.json", before, after: null }]),
    ).toEqual([]);
  });
});

describe("config-tampering: fail-closed edge cases", () => {
  test("settings.json that only a JSONC parser accepts is blocked", () => {
    const before = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "npx cheatguard hook claude-code" }] }],
      },
    });
    const after = before.replace("{", "{ // comments make strict JSON parsers fail\n");
    const vs = run(configTampering, [{ path: ".claude/settings.json", before, after }]);
    expect(blocks(vs)).toHaveLength(1);
    expect(vs[0]?.detail).toContain("valid JSON");
  });

  test("a deep extends chain is followed to the end", () => {
    const files: Record<string, string> = {
      "tsconfig.json": JSON.stringify({ extends: "./c/t1.json" }),
    };
    for (let i = 1; i < 12; i += 1)
      files[`c/t${i}.json`] = JSON.stringify({ extends: `./t${i + 1}.json` });
    const vs = run(
      configTampering,
      [
        {
          path: "c/t12.json",
          before: JSON.stringify({ compilerOptions: { strict: true } }),
          after: JSON.stringify({ compilerOptions: { strict: false } }),
        },
      ],
      { files },
    );
    expect(blocks(vs)).toHaveLength(1);
  });

  test("a bare directory in a new test include does not count as covering its files", () => {
    const vitest = (include: string): string =>
      `export default { test: { include: [${include}] } };\n`;
    const vs = run(
      configTampering,
      [{ path: "vitest.config.ts", before: vitest(`"src/**/*.test.ts"`), after: vitest(`"src"`) }],
      { files: TESTS },
    );
    expect(blocks(vs)).toHaveLength(1);
  });

  test("a new test config that leaves existing tests out is blocked", () => {
    const vs = run(
      configTampering,
      [
        {
          path: "vitest.config.ts",
          after: `export default { test: { include: ["nothing/**/*.test.ts"] } };\n`,
        },
      ],
      { files: { ...TESTS, "vite.config.ts": "export default {};\n" } },
    );
    expect(blocks(vs)).toHaveLength(1);
    expect(vs[0]?.detail).toContain("src/sum.test.ts");
  });

  test("a new test config that includes every existing test is fine", () => {
    const vs = run(
      configTampering,
      [
        {
          path: "vitest.config.ts",
          after: `export default { test: { include: ["src/**/*.test.ts"] } };\n`,
        },
      ],
      { files: TESTS },
    );
    expect(vs).toEqual([]);
  });

  const WF = `jobs:\n  test:\n    steps:\n      - run: npm test\n`;
  test.each([
    [
      "set +e",
      WF.replace(
        "      - run: npm test\n",
        "      - run: |\n          set +e\n          npm test\n",
      ),
    ],
    ["exit 0 after the check", WF.replace("npm test", "npm test; exit 0")],
    [
      "continue-on-error expression",
      WF.replace("  test:\n", `  test:\n    continue-on-error: $\{{ true }}\n`),
    ],
    ["quoted false if", WF.replace("  test:\n", "  test:\n    if: 'false'\n")],
    ["GitLab when: never", WF.replace("  test:\n", "  test:\n    when: never\n")],
  ])("CI %s is blocked", (_label, after) => {
    expect(
      blocks(run(configTampering, [{ path: ".github/workflows/ci.yml", before: WF, after }])),
    ).toHaveLength(1);
  });
});

describe("config-tampering: workspace scope", () => {
  test("removing a package glob from pnpm-workspace.yaml is blocked", () => {
    const before = "packages:\n  - packages/*\n  - bench\n";
    const after = "packages:\n  - bench\n";
    const vs = run(configTampering, [{ path: "pnpm-workspace.yaml", before, after }]);
    expect(blocks(vs)).toHaveLength(1);
    expect(vs[0]?.detail).toContain("packages/*");
  });

  test("adding a workspace package is fine", () => {
    const before = "packages:\n  - packages/*\n";
    const after = "packages:\n  - packages/*\n  - tools\n";
    expect(run(configTampering, [{ path: "pnpm-workspace.yaml", before, after }])).toEqual([]);
  });

  test("removing an entry from package.json workspaces is blocked", () => {
    const before = JSON.stringify({ workspaces: ["packages/*", "apps/*"] });
    const after = JSON.stringify({ workspaces: ["apps/*"] });
    expect(blocks(run(configTampering, [{ path: "package.json", before, after }]))).toHaveLength(1);
  });
});

describe("config-tampering: workspace scope edge cases", () => {
  const WS = "packages:\n  - packages/*\n  - bench\n";
  test("renaming pnpm-workspace.yaml is blocked", () => {
    const vs = run(configTampering, [
      { path: "pnpm-workspace.yml", oldPath: "pnpm-workspace.yaml", before: WS, after: WS },
    ]);
    expect(blocks(vs)).toHaveLength(1);
  });

  test("a new negation that drops packages is blocked", () => {
    const vs = run(configTampering, [
      { path: "pnpm-workspace.yaml", before: WS, after: `${WS}  - "!packages/core"\n` },
    ]);
    expect(blocks(vs)).toHaveLength(1);
  });

  test("flow-style package lists are understood", () => {
    const vs = run(configTampering, [
      {
        path: "pnpm-workspace.yaml",
        before: "packages: ['packages/*', 'bench']\n",
        after: "packages: ['bench']\n",
      },
    ]);
    expect(blocks(vs)).toHaveLength(1);
  });

  test("a new negation in package.json workspaces is blocked", () => {
    const before = JSON.stringify({ workspaces: ["packages/*"] });
    const after = JSON.stringify({ workspaces: ["packages/*", "!packages/core"] });
    expect(blocks(run(configTampering, [{ path: "package.json", before, after }]))).toHaveLength(1);
  });
});

describe("config-tampering: workspace YAML is parsed like pnpm parses it", () => {
  test("moving the list under another key is a removal", () => {
    const before = "packages:\n  - packages/*\n";
    const after = "catalog:\n  packages:\n    - packages/*\n";
    expect(
      blocks(run(configTampering, [{ path: "pnpm-workspace.yaml", before, after }])),
    ).toHaveLength(1);
  });

  test("an anchor or a multi-line flow list keeps the same packages", () => {
    const before = "packages:\n  - packages/*\n  - bench\n";
    const after = "packages: [\n  'packages/*',\n  bench,\n]\n";
    expect(run(configTampering, [{ path: "pnpm-workspace.yaml", before, after }])).toEqual([]);
  });

  test("an unparseable workspace file counts as removing every package", () => {
    const before = "packages:\n  - packages/*\n";
    expect(
      blocks(
        run(configTampering, [{ path: "pnpm-workspace.yaml", before, after: "packages: [\n" }]),
      ).length,
    ).toBe(1);
  });
});

describe("config-tampering: CI parsed as YAML", () => {
  const P = ".github/workflows/ci.yml";
  const WF =
    "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - name: tests\n        run: npm test\n";
  test.each([
    [
      "step if with an always-false expression",
      WF.replace("      - name: tests\n", `      - name: tests\n        if: $\{{ false }}\n`),
    ],
    [
      "job-level continue-on-error expression",
      WF.replace("    runs-on", `    continue-on-error: $\{{ true }}\n    runs-on`),
    ],
    [
      "a multi-line run that swallows the failure",
      WF.replace("        run: npm test\n", "        run: |\n          npm test || true\n"),
    ],
    [
      "the check moved into a step that never runs",
      WF.replace("        run: npm test\n", "        if: false\n        run: npm test\n"),
    ],
    [
      "the job removed",
      "jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n",
    ],
    ["an unparseable workflow", "jobs: [\n"],
  ])("%s is blocked", (_label, after) => {
    expect(
      blocks(run(configTampering, [{ path: P, before: WF, after }])).length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("renaming a step or reformatting is fine", () => {
    const after = WF.replace("name: tests", "name: unit tests").replace(
      "      - run: npm ci\n",
      "      - run: 'npm ci'\n",
    );
    expect(run(configTampering, [{ path: P, before: WF, after }])).toEqual([]);
  });

  test("GitLab allow_failure and when: never are blocked", () => {
    const before = "test:\n  script:\n    - npm test\n";
    expect(
      blocks(
        run(configTampering, [
          { path: ".gitlab-ci.yml", before, after: `${before}  allow_failure: true\n` },
        ]),
      ),
    ).toHaveLength(1);
    expect(
      blocks(
        run(configTampering, [
          { path: ".gitlab-ci.yml", before, after: `${before}  rules:\n    - when: never\n` },
        ]),
      ),
    ).toHaveLength(1);
  });
});

test("a CI file that stops being valid YAML is blocked even when its lines look intact", () => {
  const before = "jobs:\n  test:\n    steps:\n      - run: npm test\n";
  const after = "jobs:\n  test:\n    steps:\n      - run: npm test\n  \tbad: [\n";
  const vs = run(configTampering, [{ path: ".github/workflows/ci.yml", before, after }]);
  expect(vs.some((v) => v.detail.includes("valid YAML"))).toBe(true);
});
