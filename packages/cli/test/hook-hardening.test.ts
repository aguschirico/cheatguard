import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "@cheatguard/core";
import { describe, expect, test } from "vitest";
import { cli, createTempRepo } from "./helpers.js";

const SRC = "export function f(a: string): number {\n  return a.length;\n}\n";

function hook(cwd: string, payload: Record<string, unknown>) {
  return cli(["hook", "claude-code"], {
    cwd,
    input: JSON.stringify({ session_id: "h1", cwd, ...payload }),
  });
}

function setup() {
  const repo = createTempRepo({
    "package.json": "{}",
    "src/a.ts": SRC,
    "cheatguard.config.json": "{}",
  });
  hook(repo.root, { hook_event_name: "SessionStart", source: "startup" });
  return repo;
}

describe("hook hardening", () => {
  test("the agent cannot switch rules off by editing cheatguard.config.json", () => {
    const repo = setup();
    repo.write(
      "cheatguard.config.json",
      JSON.stringify({ rules: { "config-tampering": "off", "type-suppression": "off" } }),
    );
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    const out = JSON.parse(hook(repo.root, { hook_event_name: "Stop" }).stdout) as {
      decision: string;
      reason: string;
    };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("config-tampering");
    expect(out.reason).toContain("type-suppression");
  });

  test("an invalid working-tree config does not disable the checks", () => {
    const repo = setup();
    repo.write("cheatguard.config.json", "{ not json");
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    expect(JSON.parse(hook(repo.root, { hook_event_name: "Stop" }).stdout).decision).toBe("block");
  });

  test("session state is kept outside the repository", () => {
    const repo = setup();
    expect(existsSync(join(repo.root, ".cheatguard"))).toBe(false);
    expect(existsSync(join(stateDir(repo.root), "sessions", "h1.json"))).toBe(true);
  });

  test("an internal failure at Stop is surfaced to the user instead of passing silently", () => {
    const repo = setup();
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    writeFileSync(join(repo.root, ".git", "index"), "garbage");
    const out = JSON.parse(hook(repo.root, { hook_event_name: "Stop" }).stdout) as {
      systemMessage: string;
    };
    expect(out.systemMessage).toContain("could not check");
    expect(readFileSync(join(stateDir(repo.root), "errors.log"), "utf8")).toContain("Error");
  });
});

describe("check reads its config from the base", () => {
  test("uncommitted config edits do not relax the CLI check", () => {
    const repo = createTempRepo({
      "package.json": "{}",
      "src/a.ts": SRC,
      "cheatguard.config.json": "{}",
    });
    repo.write(
      "cheatguard.config.json",
      JSON.stringify({ rules: { "type-suppression": "off", "config-tampering": "off" } }),
    );
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    const r = cli(["check", "--no-lint"], { cwd: repo.root });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("type-suppression");
  });
});
