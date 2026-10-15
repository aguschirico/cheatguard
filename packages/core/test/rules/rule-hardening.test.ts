import { describe, expect, test } from "vitest";
import { configTampering } from "../../src/rules/config-tampering.js";
import { phantomImport } from "../../src/rules/phantom-import.js";
import { run } from "../helpers/rules.js";

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true } }, null, 2);
const ESLINT = `export default [{ rules: { eqeqeq: "error" } }];\n`;

describe("config-tampering hardening", () => {
  test("explicitly disabling a strict-family flag that was inherited is blocked", () => {
    const after = JSON.stringify(
      { compilerOptions: { strict: true, noImplicitAny: false } },
      null,
      2,
    );
    const vs = run(configTampering, [{ path: "tsconfig.json", before: TSCONFIG, after }]);
    expect(vs.map((v) => v.severity)).toEqual(["block"]);
    expect(vs[0]?.detail).toContain("noImplicitAny");
  });

  test("turning off an ESLint rule that was only inherited from a preset is blocked", () => {
    const after = `export default [{ rules: { eqeqeq: "error", "no-console": "off" } }];\n`;
    expect(
      run(configTampering, [{ path: "eslint.config.js", before: ESLINT, after }]).map(
        (v) => v.severity,
      ),
    ).toEqual(["block"]);
  });

  test("turning off a Biome rule that was only inherited from recommended is blocked", () => {
    const before = JSON.stringify({ linter: { rules: { recommended: true } } });
    const after = JSON.stringify({
      linter: { rules: { recommended: true, suspicious: { noExplicitAny: "off" } } },
    });
    expect(
      run(configTampering, [{ path: "biome.json", before, after }]).map((v) => v.severity),
    ).toEqual(["block"]);
  });

  test("removing an extended preset is blocked", () => {
    const before = JSON.stringify({
      extends: ["eslint:recommended", "plugin:@typescript-eslint/strict"],
    });
    const after = JSON.stringify({ extends: ["eslint:recommended"] });
    expect(
      run(configTampering, [{ path: ".eslintrc.json", before, after }]).map((v) => v.severity),
    ).toEqual(["block"]);
  });

  test.each(["tsconfig.json", "eslint.config.js", "biome.json", "vitest.config.ts"])(
    "deleting %s is blocked",
    (path) => {
      const before = path.endsWith(".json") ? TSCONFIG : ESLINT;
      expect(run(configTampering, [{ path, before, after: null }]).map((v) => v.severity)).toEqual([
        "block",
      ]);
    },
  );

  test("a config that no longer parses is blocked", () => {
    expect(
      run(configTampering, [
        { path: "tsconfig.json", before: TSCONFIG, after: `{ "compilerOptions": { "strict": ` },
      ]).map((v) => v.severity),
    ).toEqual(["block"]);
    expect(
      run(configTampering, [
        { path: "eslint.config.js", before: ESLINT, after: "export default [{ rules: " },
      ]).map((v) => v.severity),
    ).toEqual(["block"]);
  });

  test("other edits to a guarded script are a warning", () => {
    const before = JSON.stringify({ scripts: { test: "vitest run" } });
    const after = JSON.stringify({ scripts: { test: "vitest run src/only-this.test.ts" } });
    expect(
      run(configTampering, [{ path: "package.json", before, after }]).map((v) => v.severity),
    ).toEqual(["warn"]);
  });
});

describe("phantom-import hardening", () => {
  const files = {
    "package.json": JSON.stringify({
      name: "root",
      dependencies: { zod: "3" },
      imports: { "#lib/*": "./src/lib/*" },
    }),
    "src/lib/x.ts": "export const x = 1;\n",
  };
  const P = "src/main.ts";

  test("a # specifier not declared in package.json imports is flagged", () => {
    expect(
      run(phantomImport, [{ path: P, after: `import y from "#nope/y";\n` }], { files }),
    ).toHaveLength(1);
  });

  test("a # specifier matching package.json imports is fine", () => {
    expect(
      run(phantomImport, [{ path: P, after: `import { x } from "#lib/x";\n` }], { files }),
    ).toEqual([]);
  });

  test("npm: and jsr: specifiers are checked as packages", () => {
    expect(
      run(phantomImport, [{ path: P, after: `import a from "npm:axios";\n` }], { files }),
    ).toHaveLength(1);
    expect(
      run(phantomImport, [{ path: P, after: `import z from "npm:zod@3";\n` }], { files }),
    ).toEqual([]);
  });

  test("absolute imports that do not exist are flagged", () => {
    expect(
      run(phantomImport, [{ path: P, after: `import a from "/etc/nothing";\n` }], { files }),
    ).toHaveLength(1);
  });

  test("a package.json added in the same change cannot whitelist an undeclared package", () => {
    const vs = run(
      phantomImport,
      [
        { path: P, after: `import axios from "axios";\n` },
        { path: "vendor/fake/package.json", after: JSON.stringify({ name: "axios" }) },
      ],
      { files },
    );
    expect(vs).toHaveLength(1);
  });
});

describe("scope-creep hardening", () => {
  test("a file moved from outside the scope into it is reported", async () => {
    const { scopeCreep } = await import("../../src/rules/scope-creep.js");
    const vs = run(
      scopeCreep,
      [{ path: "src/auth/stolen.ts", oldPath: "src/billing/core.ts", before: "a", after: "a" }],
      {
        config: { scope: { allow: ["src/auth/**"] } },
      },
    );
    expect(vs).toHaveLength(1);
    expect(vs[0]?.detail).toContain("src/billing/core.ts");
  });
});

describe("config-tampering hardening (round 2)", () => {
  test("renaming a config so the tool stops loading it is blocked", () => {
    const vs = run(configTampering, [
      {
        path: "eslint.config.disabled.js",
        oldPath: "eslint.config.js",
        before: ESLINT,
        after: ESLINT,
      },
    ]);
    expect(vs.map((v) => v.severity)).toEqual(["block"]);
    expect(vs[0]?.detail).toContain("renamed");
  });

  test("every path classified as a config gets its literals compared", () => {
    const before = `export default { test: { coverage: { thresholds: { lines: 90 } } } };\n`;
    const after = before.replace("90", "10");
    expect(
      run(configTampering, [{ path: "vitest.e2e.config.ts", before, after }]).map(
        (v) => v.severity,
      ),
    ).toEqual(["block"]);
  });

  test("eslintConfig inside package.json is checked", () => {
    const before = JSON.stringify({ eslintConfig: { rules: { eqeqeq: "error" } } });
    const after = JSON.stringify({ eslintConfig: { rules: { eqeqeq: "off" } } });
    expect(
      run(configTampering, [{ path: "package.json", before, after }]).map((v) => v.severity),
    ).toEqual(["block"]);
  });

  test("jest config inside package.json is checked", () => {
    const before = JSON.stringify({ jest: { testPathIgnorePatterns: ["/node_modules/"] } });
    const after = JSON.stringify({ jest: { testPathIgnorePatterns: ["/node_modules/", "auth"] } });
    expect(
      run(configTampering, [{ path: "package.json", before, after }]).map((v) => v.severity),
    ).toEqual(["block"]);
  });
});

describe("phantom-import hardening (round 2)", () => {
  const files = {
    "package.json": JSON.stringify({ name: "root", dependencies: { zod: "3" } }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "*": ["*"], "@app/*": ["src/*"] } },
    }),
    "src/lib.ts": "export const l = 1;\n",
    "packages/util/package.json": JSON.stringify({ name: "axios" }),
  };

  test("a catch-all paths alias does not whitelist packages", () => {
    expect(
      run(phantomImport, [{ path: "src/main.ts", after: `import dayjs from "dayjs";\n` }], {
        files,
      }),
    ).toHaveLength(1);
  });

  test("an alias whose target exists still works", () => {
    expect(
      run(phantomImport, [{ path: "src/main.ts", after: `import { l } from "@app/lib";\n` }], {
        files,
      }),
    ).toEqual([]);
  });

  test("renaming a workspace package to an undeclared name does not whitelist it", () => {
    const vs = run(
      phantomImport,
      [
        { path: "src/main.ts", after: `import axios from "axios";\n` },
        {
          path: "packages/util/package.json",
          before: JSON.stringify({ name: "@acme/util" }),
          after: JSON.stringify({ name: "axios" }),
        },
      ],
      { files },
    );
    expect(vs).toHaveLength(1);
  });
});

describe("config-tampering hardening (round 3)", () => {
  test("appending a flat-config object that turns a rule off is blocked", () => {
    const before = `export default [{ rules: { eqeqeq: "error" } }];\n`;
    const after = `export default [{ rules: { eqeqeq: "error" } }, { files: ["src/**"], rules: { eqeqeq: "off" } }];\n`;
    expect(
      run(configTampering, [{ path: "eslint.config.js", before, after }]).map((v) => v.severity),
    ).toContain("block");
  });

  test("an eslintrc override that turns a rule off is blocked", () => {
    const before = JSON.stringify({ rules: { eqeqeq: "error" } });
    const after = JSON.stringify({
      rules: { eqeqeq: "error" },
      overrides: [{ files: ["*.ts"], rules: { eqeqeq: "off" } }],
    });
    expect(
      run(configTampering, [{ path: ".eslintrc.json", before, after }]).map((v) => v.severity),
    ).toContain("block");
  });

  test("a Biome override that turns a rule off is blocked", () => {
    const before = JSON.stringify({ linter: { rules: { recommended: true } } });
    const after = JSON.stringify({
      linter: { rules: { recommended: true } },
      overrides: [
        { includes: ["src/**"], linter: { rules: { suspicious: { noExplicitAny: "off" } } } },
      ],
    });
    expect(
      run(configTampering, [{ path: "biome.json", before, after }]).map((v) => v.severity),
    ).toContain("block");
  });

  test("a new vitest config that enables passWithNoTests is blocked", () => {
    const after = `export default { test: { passWithNoTests: true } };\n`;
    expect(
      run(configTampering, [{ path: "vitest.config.ts", after }]).map((v) => v.severity),
    ).toEqual(["block"]);
  });

  test("a new nested eslintrc that turns rules off is blocked", () => {
    const after = JSON.stringify({ rules: { "@typescript-eslint/no-explicit-any": "off" } });
    expect(
      run(configTampering, [{ path: "src/legacy/.eslintrc.json", after }]).map((v) => v.severity),
    ).toEqual(["block"]);
  });

  test("a new tsconfig that disables strict checks is blocked", () => {
    const after = JSON.stringify({ compilerOptions: { strict: false } });
    expect(
      run(configTampering, [{ path: "src/tsconfig.json", after }]).map((v) => v.severity),
    ).toEqual(["block"]);
  });

  test("a new ordinary config with typical excludes is fine", () => {
    const after = JSON.stringify({
      compilerOptions: { strict: true },
      exclude: ["node_modules", "dist"],
    });
    expect(run(configTampering, [{ path: "tsconfig.build.json", after }])).toEqual([]);
  });
});

describe("config-tampering hardening (round 4)", () => {
  test("duplicate keys are read last-wins, like JSON.parse and the tools", () => {
    const after = `{ "compilerOptions": { "strict": true, "strict": false } }`;
    expect(
      run(configTampering, [{ path: "tsconfig.json", before: TSCONFIG, after }]).map(
        (v) => v.severity,
      ),
    ).toEqual(["block"]);
  });

  test("duplicate keys in JS configs are read last-wins too", () => {
    const before = `export default [{ rules: { eqeqeq: "error" } }];\n`;
    const after = `export default [{ rules: { eqeqeq: "error", eqeqeq: "off" } }];\n`;
    expect(
      run(configTampering, [{ path: "eslint.config.js", before, after }]).map((v) => v.severity),
    ).toEqual(["block"]);
  });
});
