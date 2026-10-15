import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/index.js";
import { createProjectContext, diskSource } from "../../src/project.js";
import { analyzeChange, createRuleContext, testMatcher } from "../../src/rules/analyze.js";
import { phantomImport } from "../../src/rules/phantom-import.js";
import { createTempRepo } from "../helpers/repo.js";
import { makeChange } from "../helpers/rules.js";

test("a dependency declared but not installed is flagged when node_modules exists", () => {
  const repo = createTempRepo({
    "package.json": JSON.stringify({ name: "r", dependencies: { zod: "3", "made-up-pkg": "1" } }),
  });
  mkdirSync(join(repo.root, "node_modules", "zod"), { recursive: true });
  writeFileSync(join(repo.root, "node_modules", "zod", "package.json"), "{}");
  const project = createProjectContext(repo.root, diskSource(repo.root));
  const changes = [
    makeChange({
      path: "src/a.ts",
      after: `import { z } from "zod";\nimport m from "made-up-pkg";\n`,
    }),
  ].map((c) => analyzeChange(c, testMatcher(DEFAULT_CONFIG)));
  const vs = phantomImport.check(createRuleContext(changes, project, DEFAULT_CONFIG));
  expect(vs.map((v) => v.detail)).toEqual([expect.stringContaining("made-up-pkg")]);
  expect(vs[0]?.detail).toContain("not installed");
});
