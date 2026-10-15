import { describe, expect, test } from "vitest";
import { phantomImport } from "../../src/rules/phantom-import.js";
import { run } from "../helpers/rules.js";

const files = {
  "package.json": JSON.stringify({
    name: "root",
    dependencies: { zod: "3" },
    devDependencies: { "@types/express": "4" },
  }),
  "packages/app/package.json": JSON.stringify({ name: "@acme/app", dependencies: { react: "18" } }),
  "packages/lib/package.json": JSON.stringify({ name: "@acme/lib" }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }),
  "src/util.ts": "export const u = 1;\n",
  "src/dir/index.ts": "export const d = 1;\n",
};
const P = "src/main.ts";
const BEFORE = `import { z } from "zod";\nexport const main = 1;\n`;
const withImport = (line: string): string => `${line}\n${BEFORE}`;

describe("phantom-import: positives", () => {
  test("flags a package that is not declared", () => {
    const vs = run(
      phantomImport,
      [{ path: P, before: BEFORE, after: withImport(`import axios from "axios";`) }],
      { files },
    );
    expect(vs).toHaveLength(1);
    expect(vs[0]?.severity).toBe("block");
    expect(vs[0]?.detail).toContain("axios");
    expect(vs[0]?.line).toBe(1);
  });

  test("flags a scoped package that is not declared", () => {
    expect(
      run(
        phantomImport,
        [{ path: P, before: BEFORE, after: withImport(`import x from "@tanstack/query/core";`) }],
        { files },
      )[0]?.detail,
    ).toContain("@tanstack/query");
  });

  test("flags a relative import that does not resolve", () => {
    const vs = run(
      phantomImport,
      [{ path: P, before: BEFORE, after: withImport(`import { h } from "./helpers";`) }],
      { files },
    );
    expect(vs[0]?.detail).toContain("./helpers");
  });

  test("flags require of an undeclared package", () => {
    expect(
      run(
        phantomImport,
        [{ path: P, before: BEFORE, after: withImport(`const l = require("lodash");`) }],
        { files },
      ),
    ).toHaveLength(1);
  });

  test("flags dynamic import of an undeclared package", () => {
    expect(
      run(
        phantomImport,
        [{ path: P, before: BEFORE, after: withImport(`const m = await import("left-pad");`) }],
        { files },
      ),
    ).toHaveLength(1);
  });

  test("flags a value import satisfied only by @types", () => {
    expect(
      run(
        phantomImport,
        [{ path: P, before: BEFORE, after: withImport(`import express from "express";`) }],
        { files },
      ),
    ).toHaveLength(1);
  });

  test("flags a sibling workspace dependency that this package does not declare", () => {
    const vs = run(
      phantomImport,
      [{ path: "packages/lib/index.ts", after: `import React from "react";\n` }],
      { files },
    );
    expect(vs).toHaveLength(1);
  });

  test("flags re-exports from undeclared packages", () => {
    expect(
      run(
        phantomImport,
        [{ path: P, before: BEFORE, after: withImport(`export * from "chalk";`) }],
        { files },
      ),
    ).toHaveLength(1);
  });

  test("flags undeclared imports in brand-new files", () => {
    expect(
      run(phantomImport, [{ path: "src/new.ts", after: `import dayjs from "dayjs";\n` }], {
        files,
      }),
    ).toHaveLength(1);
  });

  test("flags an import of a file deleted in the same change", () => {
    const vs = run(
      phantomImport,
      [
        { path: P, before: BEFORE, after: withImport(`import { gone } from "./gone";`) },
        { path: "src/gone.ts", before: "export const gone = 1;\n", after: null },
      ],
      { files },
    );
    expect(vs).toHaveLength(1);
  });
});

describe("phantom-import: negatives", () => {
  test.each([
    ["declared package", `import { z as zz } from "zod/v4";`],
    ["node builtin", `import { readFileSync } from "fs";`],
    ["node: builtin", `import { test } from "node:test";`],
    ["tsconfig alias", `import { u } from "@/util";`],
    ["relative file", `import { u } from "./util";`],
    ["relative .js mapped to .ts", `import { u } from "./util.js";`],
    ["directory index", `import { d } from "./dir";`],
    ["type-only import covered by @types", `import type { Request } from "express";`],
    ["workspace package", `import { x } from "@acme/lib";`],
    ["URL-scheme specifier", `import data from "virtual:my-module";`],
  ])("accepts %s", (_name, line) => {
    expect(
      run(phantomImport, [{ path: P, before: BEFORE, after: withImport(line) }], { files }),
    ).toEqual([]);
  });

  test("an existing broken import that was not touched is not reported", () => {
    const before = `import x from "missing-pkg";\n${BEFORE}`;
    const after = `${before}export const more = 2;\n`;
    expect(run(phantomImport, [{ path: P, before, after }], { files })).toEqual([]);
  });

  test("a declared dependency added in the same change is fine", () => {
    const vs = run(
      phantomImport,
      [
        { path: P, before: BEFORE, after: withImport(`import axios from "axios";`) },
        {
          path: "package.json",
          before: files["package.json"],
          after: JSON.stringify({ name: "root", dependencies: { zod: "3", axios: "1" } }),
        },
      ],
      { files },
    );
    expect(vs).toEqual([]);
  });

  test("non-code files are ignored", () => {
    expect(
      run(phantomImport, [{ path: "README.md", before: "", after: `import x from "nope";` }], {
        files,
      }),
    ).toEqual([]);
  });
});
