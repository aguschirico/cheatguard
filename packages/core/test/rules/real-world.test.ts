import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/index.js";
import { configTampering } from "../../src/rules/config-tampering.js";
import { phantomImport } from "../../src/rules/phantom-import.js";
import { stubLeft } from "../../src/rules/stub-left.js";
import { testWeakened } from "../../src/rules/test-weakened.js";
import { run } from "../helpers/rules.js";

// Regressions found by benchmark A on real agent pull requests.

describe("test-weakened (real-world)", () => {
  const T = `import { expect, it } from "vitest";\nimport { trust } from "./schedule";\nit("writes a quoted trusted entry for a dotted directory", () => {\n  expect(trust("a.b")).toContain("trusted");\n  expect(trust("a.b")).not.toContain("x");\n});\nit("keeps going", () => {\n  expect(1).toBe(1);\n});\n`;
  test("a test moved to another test file in the same change is not deleted", () => {
    const moved = `import { expect, it } from "vitest";\nimport { trust } from "./folder-trust";\nit("writes a quoted trusted entry for a dotted directory", () => {\n  expect(trust("a.b")).toContain("trusted");\n  expect(trust("a.b")).not.toContain("x");\n});\n`;
    const vs = run(testWeakened, [
      {
        path: "src/schedules.test.ts",
        before: T,
        after: T.replace(/it\("writes[\s\S]*?\n\}\);\n/, ""),
      },
      { path: "src/folder-trust.test.ts", after: moved },
    ]);
    expect(vs).toEqual([]);
  });

  test("a renamed test that gained assertions is not deleted", () => {
    const after = T.replace(
      'it("keeps going", () => {\n  expect(1).toBe(1);',
      'it("keeps going and says nothing", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);',
    );
    expect(run(testWeakened, [{ path: "src/schedules.test.ts", before: T, after }])).toEqual([]);
  });
});

describe("phantom-import (real-world)", () => {
  const files = {
    "package.json": JSON.stringify({
      name: "ext",
      devDependencies: { "@types/vscode": "^1.90.0" },
    }),
    "apps/web/package.json": JSON.stringify({ name: "web" }),
    "apps/web/tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "@/*": ["./src/*"] } },
    }),
    "apps/web/src/components/ui.tsx": "export const Ui = 1;\n",
    "tsconfig.web.json": JSON.stringify({
      compilerOptions: { paths: { "@renderer/*": ["src/renderer/src/*"] } },
    }),
    "src/renderer/src/features/x.ts": "export const x = 1;\n",
  };
  test("runtime-provided modules declared through @types are accepted", () => {
    expect(
      run(
        phantomImport,
        [
          {
            path: "src/ext.ts",
            after: `import * as vscode from "vscode";\nexport const v = vscode;\n`,
          },
        ],
        { files },
      ),
    ).toEqual([]);
  });
  test("aliases from nested and sibling tsconfig files resolve", () => {
    expect(
      run(
        phantomImport,
        [
          {
            path: "apps/web/src/page.tsx",
            after: `import { Ui } from "@/components/ui";\nexport const p = Ui;\n`,
          },
        ],
        { files },
      ),
    ).toEqual([]);
    expect(
      run(
        phantomImport,
        [
          {
            path: "src/renderer/src/app.ts",
            after: `import { x } from "@renderer/features/x";\nexport const a = x;\n`,
          },
        ],
        { files },
      ),
    ).toEqual([]);
  });
  test("specifiers that cannot be npm package names are treated as bundler aliases", () => {
    expect(
      run(
        phantomImport,
        [
          {
            path: "src/routes/page.ts",
            after: `import { db } from "$lib/db";\nimport { a } from "~/a";\nimport b from "@/b";\nexport { a, b, db };\n`,
          },
        ],
        { files },
      ),
    ).toEqual([]);
  });
  test("a real undeclared scoped package is still flagged", () => {
    expect(
      run(
        phantomImport,
        [
          {
            path: "src/ext.ts",
            after: `import { q } from "@tanstack/query-core";\nexport { q };\n`,
          },
        ],
        { files },
      ),
    ).toHaveLength(1);
  });
});

describe("config-tampering (real-world)", () => {
  test("vite optimizeDeps.exclude is not a test exclusion", () => {
    const before = `export default { optimizeDeps: { exclude: ["a"] }, test: { exclude: ["dist"] } };\n`;
    const after = `export default { optimizeDeps: { exclude: ["a", "b"] }, test: { exclude: ["dist"] } };\n`;
    expect(run(configTampering, [{ path: "vite.config.ts", before, after }])).toEqual([]);
  });
  test("replacing test include patterns is fine when every test still matches, removing them is blocking", () => {
    const before = `export default { test: { include: ["packages/*/test/**/*.test.ts"] } };\n`;
    const replaced = `export default { test: { include: ["packages/*/src/**/*.test.ts", "packages/*/src/__tests__/**/*.test.ts"] } };\n`;
    const removed = `export default { test: { include: [] } };\n`;
    // Tests moved from test/ to src/ together with the patterns.
    const moved = { "packages/a/src/x.test.ts": "", "packages/a/src/__tests__/y.test.ts": "" };
    expect(
      run(configTampering, [{ path: "vitest.config.ts", before, after: replaced }], {
        files: moved,
      }),
    ).toEqual([]);
    // A test left behind in test/ would stop running.
    const left = { ...moved, "packages/a/test/z.test.ts": "" };
    expect(
      run(configTampering, [{ path: "vitest.config.ts", before, after: replaced }], {
        files: left,
      }).map((v) => v.severity),
    ).toEqual(["block"]);
    expect(
      run(configTampering, [{ path: "vitest.config.ts", before, after: removed }]).map(
        (v) => v.severity,
      ),
    ).toEqual(["block"]);
  });
});

describe("stub-left (real-world)", () => {
  const SRC = "export function f(): number {\n  return 1;\n}\n";
  test.each([
    "// The stubbed edges are shaped as the browser gives them",
    "// placeholder text for the search box",
    "// Implements the RFC 6265 cookie parsing algorithm",
  ])("does not flag descriptive comments: %s", (comment) => {
    expect(run(stubLeft, [{ path: "src/a.ts", before: SRC, after: `${comment}\n${SRC}` }])).toEqual(
      [],
    );
  });
  test.each([
    "// placeholder implementation for now",
    "// stub implementation, replace later",
    "// not implemented yet",
  ])("still flags placeholders: %s", (comment) => {
    expect(
      run(stubLeft, [{ path: "src/a.ts", before: SRC, after: `${comment}\n${SRC}` }]),
    ).toHaveLength(1);
  });
});

describe("default ignores (real-world)", () => {
  test("generated code directories are ignored", () => {
    expect(DEFAULT_CONFIG.ignore).toEqual(
      expect.arrayContaining(["**/_generated/**", "**/__generated__/**"]),
    );
  });
});

describe("real-world round 2", () => {
  test("a test moved to another file with fewer assertions is a warning, not a deletion", () => {
    const before = `import { expect, it } from "vitest";\nit("writes the entry", () => {\n  expect(a()).toContain("x");\n  expect(a()).toContain("y");\n  expect(a()).not.toContain("z");\n});\n`;
    const moved = `import { expect, it } from "vitest";\nit("writes the entry", () => {\n  expect(a()).toBe("xy");\n  expect(b()).toBe(1);\n});\n`;
    const vs = run(testWeakened, [
      {
        path: "src/a.test.ts",
        before,
        after: `import { it } from "vitest";\nit("other", () => {});\n`,
      },
      { path: "src/b.test.ts", after: moved },
    ]);
    expect(vs.map((v) => v.severity)).toEqual(["warn"]);
  });

  test("excluding test files from coverage is fine", () => {
    const before = `export default { test: { coverage: { exclude: ["dist/**"] } } };\n`;
    const after = `export default { test: { coverage: { exclude: ["dist/**", "packages/*/src/__tests__/**", "**/*.spec.ts", "src/mocks/**"] } } };\n`;
    expect(run(configTampering, [{ path: "vitest.config.ts", before, after }])).toEqual([]);
  });

  test("excluding source files from coverage is still blocked", () => {
    const before = `export default { test: { coverage: { exclude: ["dist/**"] } } };\n`;
    const after = `export default { test: { coverage: { exclude: ["dist/**", "src/payments/**"] } } };\n`;
    expect(
      run(configTampering, [{ path: "vitest.config.ts", before, after }]).map((v) => v.severity),
    ).toEqual(["block"]);
  });

  test("framework-generated relative modules ($types) are not phantom imports", () => {
    expect(
      run(phantomImport, [
        {
          path: "src/routes/+page.server.ts",
          after: `import type { PageServerLoad } from "./$types";\nexport const load: PageServerLoad = () => ({});\n`,
        },
      ]),
    ).toEqual([]);
  });
});

describe("real-world round 2 hardening", () => {
  test("coverage excludes only pass for whole test-like path segments", () => {
    const before = `export default { test: { coverage: { exclude: ["dist/**"] } } };\n`;
    const after = `export default { test: { coverage: { exclude: ["dist/**", "src/latest/**"] } } };\n`;
    expect(
      run(configTampering, [{ path: "vitest.config.ts", before, after }]).map((v) => v.severity),
    ).toEqual(["block"]);
  });

  test("only ./$types is treated as generated, not any $-prefixed relative import", () => {
    expect(
      run(phantomImport, [
        { path: "src/a.ts", after: `import x from "./$helpers";\nexport { x };\n` },
      ]),
    ).toHaveLength(1);
  });
});

describe("test-weakened subjects through barrels", () => {
  test("an expected value change is only a warning when the code under test changed behind a barrel", () => {
    const test = `import { expect, it } from "vitest";\nimport { make } from "../index";\nit("defaults", () => {\n  expect(make()).toBeInstanceOf(A);\n});\n`;
    const vs = run(
      testWeakened,
      [
        {
          path: "src/__tests__/default.test.ts",
          before: test,
          after: test.replace("toBeInstanceOf(A)", "toBeInstanceOf(B)"),
        },
        {
          path: "src/types.ts",
          before: "export class A {}\nexport const make = () => new A();\n",
          after: "export class A {}\nexport class B {}\nexport const make = () => new B();\n",
        },
      ],
      { files: { "src/index.ts": `export * from "./types";\n` } },
    );
    expect(vs.map((v) => v.severity)).toEqual(["warn"]);
  });
});
