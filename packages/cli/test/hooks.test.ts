import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "@cheatguard/core";
import { describe, expect, test } from "vitest";
import { cli, createTempRepo, tempNonRepoDir } from "./helpers.js";

const SRC = "export function f(a: string): number {\n  return a.length;\n}\n";
const TEST = `import { expect, it } from "vitest";\nimport { f } from "./a";\nit("measures", () => {\n  expect(f("ab")).toBe(2);\n  expect(f("")).toBe(0);\n});\n`;

function hook(cwd: string, payload: Record<string, unknown>) {
  return cli(["hook", "claude-code"], {
    cwd,
    input: JSON.stringify({ session_id: "s1", cwd, transcript_path: "/tmp/t", ...payload }),
  });
}

function setup() {
  const repo = createTempRepo({
    "package.json": "{}",
    "src/a.ts": SRC,
    "src/a.test.ts": TEST,
    ".gitignore": ".cheatguard/\n",
  });
  expect(hook(repo.root, { hook_event_name: "SessionStart", source: "startup" }).status).toBe(0);
  return repo;
}

const edit = (root: string, path: string) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: { file_path: join(root, path) },
  tool_response: {},
});

describe("SessionStart", () => {
  test("records a baseline for the session", () => {
    const repo = setup();
    const state = JSON.parse(
      readFileSync(join(stateDir(repo.root), "sessions", "s1.json"), "utf8"),
    ) as { baselineTree: string; stopBlocks: number };
    expect(state.baselineTree).toMatch(/^[0-9a-f]{40}/);
    expect(state.stopBlocks).toBe(0);
  });

  test("resume keeps the original baseline", () => {
    const repo = setup();
    const first = readFileSync(join(stateDir(repo.root), "sessions", "s1.json"), "utf8");
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    hook(repo.root, { hook_event_name: "SessionStart", source: "resume" });
    expect(
      JSON.parse(readFileSync(join(stateDir(repo.root), "sessions", "s1.json"), "utf8"))
        .baselineTree,
    ).toBe(JSON.parse(first).baselineTree);
  });
});

describe("PostToolUse", () => {
  test("blocks a cheat right after the edit", () => {
    const repo = setup();
    repo.write("src/a.test.ts", TEST.replace(`  expect(f("")).toBe(0);\n`, ""));
    const r = hook(repo.root, edit(repo.root, "src/a.test.ts"));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { decision: string; reason: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("test-weakened");
  });

  test("is silent for a clean edit", () => {
    const repo = setup();
    repo.write("src/a.ts", `${SRC}export const g = 1;\n`);
    const r = hook(repo.root, edit(repo.root, "src/a.ts"));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("passes warnings as additional context without blocking", () => {
    const repo = setup();
    repo.write("src/a.ts", `${SRC}try { f("x"); } catch {}\n`);
    const out = JSON.parse(hook(repo.root, edit(repo.root, "src/a.ts")).stdout) as {
      decision?: string;
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.decision).toBeUndefined();
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("swallowed-error");
  });

  test("ignores files outside the repository and unsupported files", () => {
    const repo = setup();
    expect(
      hook(repo.root, {
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/etc/hosts" },
      }).stdout.trim(),
    ).toBe("");
    repo.write("README.md", "# hi\n");
    expect(hook(repo.root, edit(repo.root, "README.md")).stdout.trim()).toBe("");
  });

  test("changes that existed before the session are not reported", () => {
    const repo = createTempRepo({
      "package.json": "{}",
      "src/a.ts": SRC,
      ".gitignore": ".cheatguard/\n",
    });
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" });
    repo.write("src/a.ts", `${SRC.replace("a: string", "a: any")}export const g = 1;\n`);
    expect(hook(repo.root, edit(repo.root, "src/a.ts")).stdout.trim()).toBe("");
  });

  test("without a session, the baseline falls back to HEAD", () => {
    const repo = createTempRepo({
      "package.json": "{}",
      "src/a.ts": SRC,
      ".gitignore": ".cheatguard/\n",
    });
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    expect(JSON.parse(hook(repo.root, edit(repo.root, "src/a.ts")).stdout).decision).toBe("block");
  });
});

describe("Stop", () => {
  test("blocks finishing while cheats remain (including edits made through Bash)", () => {
    const repo = setup();
    repo.write("src/a.test.ts", TEST.replace(`it("measures"`, `it.skip("measures"`));
    const out = JSON.parse(
      hook(repo.root, { hook_event_name: "Stop", stop_hook_active: false }).stdout,
    ) as { decision: string; reason: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("skip");
  });

  test("lets the agent finish when the change is clean", () => {
    const repo = setup();
    repo.write("src/a.ts", `${SRC}export const g = 1;\n`);
    const r = hook(repo.root, { hook_event_name: "Stop", stop_hook_active: false });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("stops blocking after maxStopBlocks and tells the user what remains", () => {
    const repo = setup();
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    for (let i = 0; i < 3; i += 1) {
      expect(
        JSON.parse(hook(repo.root, { hook_event_name: "Stop", stop_hook_active: i > 0 }).stdout)
          .decision,
      ).toBe("block");
    }
    const last = JSON.parse(
      hook(repo.root, { hook_event_name: "Stop", stop_hook_active: true }).stdout,
    ) as { decision?: string; systemMessage: string };
    expect(last.decision).toBeUndefined();
    expect(last.systemMessage).toContain("unresolved");
  });

  test("shows new warnings to the agent once, then lets it stop and tells the user", () => {
    const repo = setup();
    repo.write("src/a.ts", `${SRC}try { f("x"); } catch {}\n`);
    const first = JSON.parse(
      hook(repo.root, { hook_event_name: "Stop", stop_hook_active: false }).stdout,
    ) as { decision?: string; reason: string };
    expect(first.decision).toBe("block");
    expect(first.reason).toContain("swallowed-error");
    expect(first.reason).toContain("will not be asked about them again");
    const second = JSON.parse(
      hook(repo.root, { hook_event_name: "Stop", stop_hook_active: true }).stdout,
    ) as { decision?: string; systemMessage: string };
    expect(second.decision).toBeUndefined();
    expect(second.systemMessage).toContain("swallowed-error");
  });

  test("warnings go only to the user when warnAgentOnStop is off", () => {
    const repo = createTempRepo({
      "package.json": "{}",
      "src/a.ts": SRC,
      "cheatguard.config.json": JSON.stringify({ hooks: { warnAgentOnStop: false } }),
    });
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" });
    repo.write("src/a.ts", `${SRC}try { f("x"); } catch {}\n`);
    const out = JSON.parse(hook(repo.root, { hook_event_name: "Stop" }).stdout) as {
      decision?: string;
      systemMessage: string;
    };
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toContain("swallowed-error");
  });
});

describe("fail-open", () => {
  test("invalid payload exits 0 and logs the error", () => {
    const repo = setup();
    const r = cli(["hook", "claude-code"], { cwd: repo.root, input: "not json" });
    expect(r.status).toBe(0);
    expect(existsSync(join(stateDir(repo.root), "errors.log"))).toBe(true);
  });

  test("outside a repository exits 0", () => {
    const dir = tempNonRepoDir();
    expect(
      cli(["hook", "claude-code"], {
        cwd: dir,
        input: JSON.stringify({ session_id: "x", cwd: dir, hook_event_name: "Stop" }),
      }).status,
    ).toBe(0);
  });

  test("unknown events are ignored", () => {
    const repo = setup();
    expect(hook(repo.root, { hook_event_name: "Notification" }).status).toBe(0);
  });
});

describe("sessions created late (no SessionStart)", () => {
  test("a second Stop still sees the agent's changes", () => {
    const repo = createTempRepo({
      "package.json": "{}",
      "src/a.ts": SRC,
      ".gitignore": ".cheatguard/\n",
    });
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    const stopPayload = { session_id: "late", hook_event_name: "Stop", stop_hook_active: false };
    const first = cli(["hook", "claude-code"], {
      cwd: repo.root,
      input: JSON.stringify({ ...stopPayload, cwd: repo.root }),
    });
    expect(JSON.parse(first.stdout).decision).toBe("block");
    const second = cli(["hook", "claude-code"], {
      cwd: repo.root,
      input: JSON.stringify({ ...stopPayload, cwd: repo.root, stop_hook_active: true }),
    });
    expect(JSON.parse(second.stdout).decision).toBe("block");
  });
});

describe("intervention audit log", () => {
  test("blocks and context messages are recorded", async () => {
    const { readInterventions } = await import("@cheatguard/core");
    const repo = setup();
    repo.write("src/a.test.ts", TEST.replace(`  expect(f("")).toBe(0);\n`, ""));
    hook(repo.root, edit(repo.root, "src/a.test.ts"));
    hook(repo.root, { hook_event_name: "Stop", stop_hook_active: false });
    const entries = readInterventions(repo.root);
    expect(entries.map((e) => [e.event, e.decision])).toEqual([
      ["PostToolUse", "block"],
      ["Stop", "block"],
    ]);
    expect(entries[0]?.rules).toEqual(["test-weakened"]);
  });
});
