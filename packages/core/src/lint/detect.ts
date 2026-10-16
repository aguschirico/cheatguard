import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CheatguardConfig, LINT_TOOLS, type LintToolName } from "../types.js";
import { isRecord } from "../util/json.js";
import { workspaceTsconfigs } from "./projects.js";

const CONFIGS: Record<LintToolName, readonly string[]> = {
  eslint: [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    "eslint.config.mts",
    "eslint.config.cts",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yaml",
    ".eslintrc.yml",
  ],
  biome: ["biome.json", "biome.jsonc"],
  oxlint: [".oxlintrc.json", "oxlint.config.ts"],
  tsc: ["tsconfig.json"],
};

/** Node entry scripts of each tool. Running them with `node` avoids shells and .cmd shims entirely. */
const SCRIPTS: Record<LintToolName, readonly string[]> = {
  eslint: ["eslint/bin/eslint.js"],
  biome: ["@biomejs/biome/bin/biome"],
  oxlint: ["oxlint/bin/oxlint"],
  tsc: ["typescript/bin/tsc"],
};

export function toolScript(root: string, tool: LintToolName): string | null {
  for (const candidate of SCRIPTS[tool]) {
    const path = join(root, "node_modules", candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

function readPackage(root: string): Record<string, unknown> | null {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return isRecord(pkg) ? pkg : null;
  } catch {
    return null;
  }
}

/** oxlint runs with built-in defaults, so a package script that calls it counts as configuring it. */
const OXLINT_SCRIPT_RE = /(^|[\s;&|(])oxlint(\s|$)/;

function hasConfig(root: string, tool: LintToolName): boolean {
  if (CONFIGS[tool].some((f) => existsSync(join(root, f)))) return true;
  if (tool === "tsc") return workspaceTsconfigs(root).length > 0;
  if (tool === "eslint") return readPackage(root)?.eslintConfig !== undefined;
  if (tool === "oxlint") {
    const scripts = readPackage(root)?.scripts;
    return (
      isRecord(scripts) &&
      Object.values(scripts).some((s) => typeof s === "string" && OXLINT_SCRIPT_RE.test(s))
    );
  }
  return false;
}

export interface MissingTool {
  tool: LintToolName;
  reason: string;
  /** Listed explicitly in lint.tools: a missing required tool is an error, not a skip. */
  required: boolean;
}

export interface ToolPlan {
  /** Tools that can run now. */
  tools: LintToolName[];
  /** Tools that should run but cannot (configured but not installed, or listed but unusable). */
  missing: MissingTool[];
}

/**
 * Which linters to run. With `lint.tools: "auto"`, a tool runs when it has a config file and a local
 * install; a config without an install is reported as missing. Tools listed explicitly are required.
 */
export function planTools(root: string, config: CheatguardConfig): ToolPlan {
  const explicit = config.lint.tools !== "auto";
  const wanted = config.lint.tools === "auto" ? LINT_TOOLS : config.lint.tools;
  const plan: ToolPlan = { tools: [], missing: [] };
  for (const tool of LINT_TOOLS) {
    if (!wanted.includes(tool)) continue;
    const installed = toolScript(root, tool) !== null;
    const configured = hasConfig(root, tool);
    if (installed && configured) plan.tools.push(tool);
    else if (explicit || configured) {
      plan.missing.push({
        tool,
        required: explicit,
        reason: !installed
          ? `${tool} is not installed (node_modules/${SCRIPTS[tool][0]} is missing)`
          : tool === "tsc"
            ? "tsc has no tsconfig.json in the repository root or in any workspace package"
            : tool === "oxlint"
              ? "oxlint has no config file in the repository root and no package script runs it"
              : `${tool} has no config file in the repository root`,
      });
    }
  }
  return plan;
}

/** Tools that are configured in the project and installed locally (or the explicit config list). */
export function detectTools(root: string, config: CheatguardConfig): LintToolName[] {
  return planTools(root, config).tools;
}
