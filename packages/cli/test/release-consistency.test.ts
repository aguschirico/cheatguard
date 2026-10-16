import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "@cheatguard/core";
import { describe, expect, test } from "vitest";
import { cli } from "./helpers.js";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const versionOf = (path: string): unknown => {
  const parsed: unknown = JSON.parse(read(path));
  return typeof parsed === "object" && parsed !== null && "version" in parsed
    ? parsed.version
    : undefined;
};

describe("release consistency", () => {
  test("every place that names the version agrees", () => {
    expect(versionOf("../package.json")).toBe(VERSION);
    expect(versionOf("../../core/package.json")).toBe(VERSION);
    expect(versionOf("../plugin/.claude-plugin/plugin.json")).toBe(VERSION);
    const commands = [...read("../plugin/hooks/hooks.json").matchAll(/cheatguard@([\w.-]+)/g)];
    expect(commands.length).toBeGreaterThan(0);
    for (const match of commands) expect(match[1]).toBe(VERSION);
    // The plugin README tells people which exact version the hooks download.
    const documented = [...read("../plugin/README.md").matchAll(/cheatguard@(\d[\w.-]*)/g)];
    expect(documented.length).toBeGreaterThan(0);
    for (const match of documented) expect(match[1]).toBe(VERSION);
  });

  test("the published JSON schema matches the config the code accepts", () => {
    const r = cli(["schema"], { cwd: process.cwd() });
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(read("../cheatguard.schema.json")));
  });
});
