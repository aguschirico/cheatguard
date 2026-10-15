import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cli, createTempRepo, tempNonRepoDir } from "./helpers.js";

const SRC = "export function f(a: string): number {\n  return a.length;\n}\n";

describe("cheatguard check", () => {
  test("exits 0 on a clean change", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
    repo.write("src/a.ts", `${SRC}export const g = 1;\n`);
    const r = cli(["check", "--no-lint"], { cwd: repo.root });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No issues");
  });

  test("exits 1 with blocking violations", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    const r = cli(["check", "--no-lint"], { cwd: repo.root });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("type-suppression");
  });

  test("--format json prints valid JSON", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    const r = cli(["check", "--no-lint", "--format", "json"], { cwd: repo.root });
    const parsed = JSON.parse(r.stdout) as { ok: boolean; violations: Array<{ rule: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.violations[0]?.rule).toBe("type-suppression");
  });

  test("--staged only checks the index", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    expect(cli(["check", "--no-lint", "--staged"], { cwd: repo.root }).status).toBe(0);
    repo.git("add", "src/a.ts");
    expect(cli(["check", "--no-lint", "--staged"], { cwd: repo.root }).status).toBe(1);
  });

  test("--base compares against another ref", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    repo.commit("introduce any");
    expect(cli(["check", "--no-lint"], { cwd: repo.root }).status).toBe(0);
    expect(cli(["check", "--no-lint", "--base", "HEAD~1"], { cwd: repo.root }).status).toBe(1);
  });

  test("restricts to paths", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC, "lib/b.ts": SRC });
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    expect(cli(["check", "--no-lint", "lib"], { cwd: repo.root }).status).toBe(0);
  });

  test("exits 3 outside a git repository", () => {
    const r = cli(["check"], { cwd: tempNonRepoDir() });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("Not a git repository");
  });

  test("exits 3 on an invalid config", () => {
    const repo = createTempRepo({
      "package.json": "{}",
      "cheatguard.config.json": `{"rules":{"nope":"block"}}`,
    });
    expect(cli(["check"], { cwd: repo.root }).status).toBe(3);
  });

  test("exits 3 on an unknown base ref", () => {
    const repo = createTempRepo({ "package.json": "{}" });
    expect(cli(["check", "--base", "does-not-exist"], { cwd: repo.root }).status).toBe(3);
  });
});

describe("other commands", () => {
  test("rules lists the 8 rules", () => {
    const r = cli(["rules"], { cwd: tempNonRepoDir() });
    expect(r.status).toBe(0);
    for (const id of [
      "test-weakened",
      "type-suppression",
      "config-tampering",
      "stub-left",
      "phantom-import",
      "swallowed-error",
      "duplicate-export",
      "scope-creep",
    ]) {
      expect(r.stdout).toContain(id);
    }
  });

  test("schema prints a JSON schema", () => {
    const parsed = JSON.parse(cli(["schema"], { cwd: tempNonRepoDir() }).stdout) as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(parsed.properties)).toContain("rules");
  });

  test("--version and --help", () => {
    expect(cli(["--version"], { cwd: tempNonRepoDir() }).stdout).toMatch(/\d+\.\d+\.\d+/);
    const help = cli(["--help"], { cwd: tempNonRepoDir() });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("cheatguard check");
  });

  test("an unknown command exits 3 with help", () => {
    const r = cli(["frobnicate"], { cwd: tempNonRepoDir() });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("Unknown command");
  });
});

describe("cheatguard init claude-code", () => {
  test("installs the three hooks without touching .gitignore", () => {
    const repo = createTempRepo({ "package.json": "{}" });
    expect(cli(["init", "claude-code"], { cwd: repo.root }).status).toBe(0);
    const settings = JSON.parse(readFileSync(join(repo.root, ".claude/settings.json"), "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolUse", "SessionStart", "Stop"]);
    expect(settings.hooks.PostToolUse?.[0]?.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toContain("cheatguard hook claude-code");
    expect(existsSync(join(repo.root, ".gitignore"))).toBe(false);
  });

  test("is idempotent and preserves unrelated settings and hooks", () => {
    const repo = createTempRepo({ "package.json": "{}" });
    repo.write(
      ".claude/settings.json",
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        hooks: {
          PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        },
      }),
    );
    cli(["init", "claude-code"], { cwd: repo.root });
    const first = readFileSync(join(repo.root, ".claude/settings.json"), "utf8");
    cli(["init", "claude-code"], { cwd: repo.root });
    const second = readFileSync(join(repo.root, ".claude/settings.json"), "utf8");
    expect(second).toBe(first);
    const settings = JSON.parse(second) as {
      permissions: unknown;
      hooks: { PostToolUse: unknown[] };
    };
    expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(settings.hooks.PostToolUse).toHaveLength(2);
  });

  test("accepts a custom hook command", () => {
    const repo = createTempRepo({ "package.json": "{}" });
    cli(["init", "claude-code", "--command", "node tools/cg.js"], { cwd: repo.root });
    expect(readFileSync(join(repo.root, ".claude/settings.json"), "utf8")).toContain(
      "node tools/cg.js hook claude-code",
    );
  });

  test("rejects an unknown agent", () => {
    const repo = createTempRepo({ "package.json": "{}" });
    expect(cli(["init", "vim"], { cwd: repo.root }).status).toBe(3);
  });
});

describe("Claude Code plugin", () => {
  test("declares the three hooks with the published CLI", () => {
    const root = join(__dirname, "..", "plugin");
    const manifest = JSON.parse(
      readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string; version: string };
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      version: string;
    };
    expect(manifest.name).toBe("cheatguard");
    expect(manifest.version).toBe(pkg.version);
    const hooks = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(Object.keys(hooks.hooks).sort()).toEqual(["PostToolUse", "SessionStart", "Stop"]);
    for (const groups of Object.values(hooks.hooks)) {
      expect(groups[0]?.hooks[0]?.command).toBe(
        `npx -y cheatguard@${pkg.version} hook claude-code`,
      );
    }
  });
});

describe("init and usage errors from the review", () => {
  test.each([
    ["null", "null"],
    ["an array", "[]"],
    ["hooks that is not an object", JSON.stringify({ hooks: [] })],
    ["an event that is not an array", JSON.stringify({ hooks: { Stop: { x: 1 } } })],
  ])("init refuses settings that are %s without a stack trace", (_label, content) => {
    const repo = createTempRepo({ "package.json": "{}" });
    repo.write(".claude/settings.json", content);
    const r = cli(["init", "claude-code"], { cwd: repo.root });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/must be|must contain/);
    expect(r.stderr).not.toContain("    at ");
  });

  test("init keeps other hooks of any shape and replaces old cheatguard hooks", () => {
    const repo = createTempRepo({ "package.json": "{}" });
    repo.write(
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "npx cheatguard@0.0.1 hook claude-code" }] },
            { custom: "shape" },
            { hooks: [{ type: "command", command: "echo other" }] },
          ],
        },
      }),
    );
    expect(cli(["init", "claude-code"], { cwd: repo.root }).status).toBe(0);
    const stop = JSON.parse(readFileSync(join(repo.root, ".claude/settings.json"), "utf8")).hooks
      .Stop as unknown[];
    expect(stop).toHaveLength(3);
    expect(JSON.stringify(stop)).not.toContain("0.0.1");
    expect(JSON.stringify(stop)).toContain("custom");
  });

  test("an unknown option is a usage error, not a crash", () => {
    const repo = createTempRepo({ "package.json": "{}" });
    const r = cli(["check", "--bogus"], { cwd: repo.root });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("--help");
    expect(r.stderr).not.toContain("    at ");
  });
});

describe("first-run config UX", () => {
  test("an uncommitted config is announced on stderr", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
    repo.write("cheatguard.config.json", JSON.stringify({ rules: { "scope-creep": "off" } }));
    const r = cli(["check", "--no-lint"], { cwd: repo.root });
    expect(r.stderr).toContain("uncommitted changes");
  });

  test("an invalid uncommitted config is reported before it is committed", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
    repo.write("cheatguard.config.json", JSON.stringify({ rules: { "no-such-rule": "off" } }));
    const r = cli(["check", "--no-lint"], { cwd: repo.root });
    expect(r.stderr).toContain("invalid");
  });
});

describe("config note safety", () => {
  // Creating file symlinks on Windows needs Developer Mode or admin rights.
  test.skipIf(process.platform === "win32")("a symlinked config is never read or echoed", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
    repo.write("secret.txt", "TOP-SECRET-VALUE not json");
    symlinkSync(join(repo.root, "secret.txt"), join(repo.root, "cheatguard.config.json"));
    const r = cli(["check", "--no-lint"], { cwd: repo.root });
    expect(r.stderr).toContain("not a regular file");
    expect(r.stderr + r.stdout).not.toContain("TOP-SECRET");
  });

  test("invalid JSON is reported without echoing the content", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
    repo.write("cheatguard.config.json", "TOP-SECRET-VALUE");
    const r = cli(["check", "--no-lint"], { cwd: repo.root });
    expect(r.stderr).toContain("not valid JSON");
    expect(r.stderr).not.toContain("TOP-SECRET");
  });
});
