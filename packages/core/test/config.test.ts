import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ConfigError, configJsonSchema, DEFAULT_CONFIG, loadConfig } from "../src/config/index.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cg-config-"));
}

describe("loadConfig", () => {
  test("returns defaults when no config file exists", () => {
    const dir = tempDir();
    const { config, path } = loadConfig(dir);
    expect(path).toBeNull();
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.tests.patterns.length).toBeGreaterThan(0);
    expect(config.hooks.maxStopBlocks).toBe(3);
  });

  test("merges a partial config over defaults", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "cheatguard.config.json"),
      JSON.stringify({ rules: { "swallowed-error": "block" }, scope: { allow: ["src/**"] } }),
    );
    const { config, path } = loadConfig(dir);
    expect(path).toBe(join(dir, "cheatguard.config.json"));
    expect(config.rules["swallowed-error"]).toBe("block");
    expect(config.scope.allow).toEqual(["src/**"]);
    expect(config.tests.patterns).toEqual(DEFAULT_CONFIG.tests.patterns);
    expect(config.lint.maxDiagnostics).toBe(DEFAULT_CONFIG.lint.maxDiagnostics);
  });

  test("accepts off as a rule severity", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "cheatguard.config.json"),
      JSON.stringify({ rules: { "duplicate-export": "off" } }),
    );
    expect(loadConfig(dir).config.rules["duplicate-export"]).toBe("off");
  });

  test("rejects an unknown rule id with the field path in the message", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "cheatguard.config.json"),
      JSON.stringify({ rules: { "no-such-rule": "block" } }),
    );
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/rules/);
  });

  test("rejects an invalid severity value", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "cheatguard.config.json"),
      JSON.stringify({ rules: { "stub-left": "error" } }),
    );
    expect(() => loadConfig(dir)).toThrow(/rules\.stub-left/);
  });

  test("rejects malformed JSON with a ConfigError", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "cheatguard.config.json"), "{ nope");
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  test("rejects an unknown lint tool", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "cheatguard.config.json"),
      JSON.stringify({ lint: { tools: ["prettier"] } }),
    );
    expect(() => loadConfig(dir)).toThrow(/lint\.tools/);
  });
});

describe("configJsonSchema", () => {
  test("describes every top-level key", () => {
    const schema = configJsonSchema();
    const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(
      ["hooks", "ignore", "lint", "rules", "scope", "tests"].sort(),
    );
  });
});
