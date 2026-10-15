import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CheatguardConfig } from "../types.js";
import { configSchema, type UserConfig } from "./schema.js";

export const CONFIG_FILE = "cheatguard.config.json";

export const DEFAULT_CONFIG: CheatguardConfig = {
  rules: {},
  scope: { allow: [] },
  tests: {
    patterns: [
      "**/*.test.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
      "**/*.spec.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
      "**/__tests__/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
      "**/test/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
      "**/tests/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
    ],
  },
  ignore: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/*.min.js",
    "**/*.generated.*",
    "**/_generated/**",
    "**/__generated__/**",
  ],
  lint: {
    tools: "auto",
    onEdit: ["eslint", "biome"],
    onStop: ["eslint", "biome", "tsc"],
    maxDiagnostics: 20,
    blockOnStop: true,
  },
  hooks: { maxStopBlocks: 3, warnAgentOnStop: true, baselineWaitSeconds: 60 },
};

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function mergeConfig(user: UserConfig): CheatguardConfig {
  return {
    rules: { ...DEFAULT_CONFIG.rules, ...user.rules },
    scope: { allow: user.scope?.allow ?? DEFAULT_CONFIG.scope.allow },
    tests: { patterns: user.tests?.patterns ?? DEFAULT_CONFIG.tests.patterns },
    ignore: user.ignore ? [...DEFAULT_CONFIG.ignore, ...user.ignore] : DEFAULT_CONFIG.ignore,
    lint: {
      tools: user.lint?.tools ?? DEFAULT_CONFIG.lint.tools,
      onEdit: user.lint?.onEdit ?? DEFAULT_CONFIG.lint.onEdit,
      onStop: user.lint?.onStop ?? DEFAULT_CONFIG.lint.onStop,
      maxDiagnostics: user.lint?.maxDiagnostics ?? DEFAULT_CONFIG.lint.maxDiagnostics,
      blockOnStop: user.lint?.blockOnStop ?? DEFAULT_CONFIG.lint.blockOnStop,
    },
    hooks: {
      maxStopBlocks: user.hooks?.maxStopBlocks ?? DEFAULT_CONFIG.hooks.maxStopBlocks,
      warnAgentOnStop: user.hooks?.warnAgentOnStop ?? DEFAULT_CONFIG.hooks.warnAgentOnStop,
      baselineWaitSeconds:
        user.hooks?.baselineWaitSeconds ?? DEFAULT_CONFIG.hooks.baselineWaitSeconds,
    },
  };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return `${path || "(root)"}: ${issue.message}`;
    })
    .join("; ");
}

/** Validates an already-parsed config object (used for file content and for tests). */
export function parseConfig(raw: unknown, source = CONFIG_FILE): CheatguardConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid ${source}: ${formatIssues(result.error)}`);
  }
  return mergeConfig(result.data);
}

/** Parses config file content; null (no file) yields the defaults. */
export function configFromText(text: string | null): CheatguardConfig {
  if (text === null) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Invalid ${CONFIG_FILE}: not valid JSON (${reason})`);
  }
  return parseConfig(raw);
}

/** Config from the working tree. Checks should prefer loadConfigAt(base) so a change cannot relax its own check. */
export function loadConfig(root: string): { config: CheatguardConfig; path: string | null } {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return { config: DEFAULT_CONFIG, path: null };
  return { config: configFromText(readFileSync(path, "utf8")), path };
}

export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(configSchema);
  const props: Record<string, unknown> = { ...(schema.properties ?? {}) };
  delete props.$schema;
  return { ...schema, properties: props };
}
