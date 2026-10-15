import { describe, expect, test } from "vitest";
import { createProjectContext, isBuiltin, memorySource, packageNameOf } from "../src/project.js";

const files = {
  "package.json": JSON.stringify({
    name: "root",
    devDependencies: { vitest: "1", "@types/express": "4" },
    workspaces: ["packages/*"],
  }),
  "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
  "tsconfig.json": `{
    // comments are allowed in tsconfig
    "extends": "./tsconfig.base.json",
    "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "~config": ["config/index.ts"] } }
  }`,
  "tsconfig.base.json": JSON.stringify({
    compilerOptions: { paths: { "#shared/*": ["shared/*"] } },
  }),
  "packages/app/package.json": JSON.stringify({
    name: "@acme/app",
    dependencies: { react: "18", "@scope/ui": "1" },
  }),
  "packages/app/src/index.ts": "",
  "packages/app/src/util.ts": "",
  "packages/app/src/dir/index.tsx": "",
  "packages/lib/package.json": JSON.stringify({ name: "@acme/lib" }),
  "apps/web/package.json": JSON.stringify({ name: "web", imports: { "#internal/*": "./src/*" } }),
  "src/local/thing.ts": "",
  "src/components/Button.tsx": "",
  "config/index.ts": "",
  "shared/x.ts": "",
  "styles/main.css": "",
};

const ctx = createProjectContext("/repo", memorySource(files));

describe("packageNameOf", () => {
  test("extracts package names from specifiers", () => {
    expect(packageNameOf("lodash")).toBe("lodash");
    expect(packageNameOf("lodash/fp")).toBe("lodash");
    expect(packageNameOf("@scope/pkg")).toBe("@scope/pkg");
    expect(packageNameOf("@scope/pkg/deep/path")).toBe("@scope/pkg");
  });
});

describe("isBuiltin", () => {
  test("recognizes node builtins with and without the node: prefix", () => {
    expect(isBuiltin("fs")).toBe(true);
    expect(isBuiltin("node:fs/promises")).toBe(true);
    expect(isBuiltin("path/posix")).toBe(true);
    expect(isBuiltin("node:test")).toBe(true);
    expect(isBuiltin("lodash")).toBe(false);
  });
});

describe("declaredDeps", () => {
  test("unions the nearest package.json with the root one", () => {
    const deps = ctx.declaredDeps("packages/app/src/index.ts");
    expect(deps.has("react")).toBe(true);
    expect(deps.has("@scope/ui")).toBe(true);
    expect(deps.has("vitest")).toBe(true);
    expect(deps.has("@acme/app")).toBe(true);
  });

  test("does not leak sibling package dependencies", () => {
    expect(ctx.declaredDeps("packages/lib/index.ts").has("react")).toBe(false);
  });
});

describe("workspacePackages", () => {
  test("includes every package name in the repository", () => {
    expect([...ctx.workspacePackages].sort()).toEqual(["@acme/app", "@acme/lib", "root", "web"]);
  });
});

describe("aliases", () => {
  test("matches tsconfig paths, including extended configs", () => {
    expect(ctx.isAliased("@/components/Button")).toBe(true);
    expect(ctx.isAliased("~config")).toBe(true);
    expect(ctx.isAliased("#shared/x")).toBe(true);
    expect(ctx.isAliased("lodash")).toBe(false);
    expect(ctx.isAliased("@/does/not/exist")).toBe(false);
  });

  test("resolves baseUrl-relative bare specifiers that exist", () => {
    expect(ctx.isAliased("src/local/thing")).toBe(true);
  });

  test("treats package.json imports (#) as aliases", () => {
    expect(ctx.isAliased("#internal/foo", "apps/web/src/a.ts")).toBe(true);
    expect(ctx.isAliased("#internal/foo", "packages/app/src/index.ts")).toBe(false);
  });
});

describe("resolveRelative", () => {
  test("resolves extensionless, .js→.ts and index files", () => {
    expect(ctx.resolveRelative("packages/app/src/index.ts", "./util")).toBe(
      "packages/app/src/util.ts",
    );
    expect(ctx.resolveRelative("packages/app/src/index.ts", "./util.js")).toBe(
      "packages/app/src/util.ts",
    );
    expect(ctx.resolveRelative("packages/app/src/index.ts", "./dir")).toBe(
      "packages/app/src/dir/index.tsx",
    );
    expect(ctx.resolveRelative("packages/app/src/dir/index.tsx", "../util")).toBe(
      "packages/app/src/util.ts",
    );
  });

  test("resolves assets with explicit extensions", () => {
    expect(ctx.resolveRelative("src/local/thing.ts", "../../styles/main.css")).toBe(
      "styles/main.css",
    );
  });

  test("returns null for missing files", () => {
    expect(ctx.resolveRelative("packages/app/src/index.ts", "./nope")).toBeNull();
    expect(ctx.resolveRelative("packages/app/src/index.ts", "../../../../outside")).toBeNull();
  });
});
