import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lintStatus, loadSession, saveSession, stateDir } from "@cheatguard/core";
import { describe, expect, test } from "vitest";
import { runAccept } from "../src/commands/accept.js";
import { cli, createTempRepo, tempNonRepoDir } from "./helpers.js";

// Repros from the adversarial review: lifecycle gaps in the Claude Code hooks.
const SRC = "export function f(a: string): number {\n  return a.length;\n}\n";
const USE = `import { f } from "./a";\nexport const n: number = f("x");\n`;
const TS_DIR = dirname(fileURLToPath(import.meta.resolve("typescript/package.json")));

function hook(cwd: string, payload: Record<string, unknown>, session = "life") {
  return cli(["hook", "claude-code"], {
    cwd,
    input: JSON.stringify({ session_id: session, cwd, ...payload }),
  });
}

const json = (stdout: string): Record<string, unknown> =>
  stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : {};

/** A repo with a real local TypeScript install, so tsc runs as a linter. */
function tsRepo(config: unknown = {}) {
  const repo = createTempRepo({
    "package.json": "{}",
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["src"],
    }),
    "src/a.ts": SRC,
    "src/use.ts": USE,
    ".gitignore": "node_modules\n",
    "cheatguard.config.json": JSON.stringify(config),
  });
  mkdirSync(join(repo.root, "node_modules"), { recursive: true });
  symlinkSync(TS_DIR, join(repo.root, "node_modules", "typescript"), "junction");
  return repo;
}

function waitForLintBaseline(root: string, session = "life"): void {
  const deadline = Date.now() + 60_000;
  while (lintStatus(root, session) !== "ready" && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  expect(lintStatus(root, session)).toBe("ready");
}

describe("linters fail closed in hooks", () => {
  test("a type error in a file the agent did not touch blocks once the baseline is ready", () => {
    const repo = tsRepo();
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" });
    waitForLintBaseline(repo.root);
    repo.write(
      "src/a.ts",
      SRC.replace("a: string): number", "a: string): string").replace("a.length", "a"),
    );
    const out = json(hook(repo.root, { hook_event_name: "Stop" }).stdout);
    expect(out.decision).toBe("block");
    expect(String(out.reason)).toContain("src/use.ts");
  }, 90_000);

  test("a Stop while the baseline is still recording waits for it instead of losing it", () => {
    const repo = tsRepo();
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" });
    repo.write(
      "src/a.ts",
      SRC.replace("a: string): number", "a: string): string").replace("a.length", "a"),
    );
    const out = json(hook(repo.root, { hook_event_name: "Stop" }).stdout);
    expect(out.decision).toBe("block");
    expect(String(out.reason)).toContain("TS2322");
    expect(lintStatus(repo.root, "life")).toBe("ready");
  }, 90_000);

  test("removing the type checker the session started with blocks Stop", () => {
    const repo = tsRepo();
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" });
    waitForLintBaseline(repo.root);
    unlinkSync(join(repo.root, "node_modules", "typescript"));
    const out = json(hook(repo.root, { hook_event_name: "Stop" }).stdout);
    expect(out.decision).toBe("block");
    expect(String(out.reason)).toContain("tsc could not run");
  }, 90_000);

  test("an ESLint config that throws is reported, and blocks when it worked at session start", () => {
    const repo = tsRepo({ lint: { tools: ["tsc"] } });
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" });
    waitForLintBaseline(repo.root);
    // tsc is listed explicitly: breaking its config is a required tool failing.
    writeFileSync(join(repo.root, "tsconfig.json"), "{ broken");
    repo.write("src/a.ts", `${SRC}export const x = 1;\n`);
    const out = json(hook(repo.root, { hook_event_name: "Stop" }).stdout);
    expect(out.decision).toBe("block");
  }, 90_000);
});

describe("baseline edges", () => {
  test("an edit made while the baseline records is still attributed to the agent", () => {
    const repo = tsRepo();
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" });
    // Edit immediately: the background baseline may lint this broken version.
    repo.write("src/use.ts", `${USE}export const bad: number = "x";\n`);
    waitForLintBaseline(repo.root);
    const out = json(hook(repo.root, { hook_event_name: "Stop" }).stdout);
    expect(out.decision).toBe("block");
    expect(String(out.reason)).toContain("src/use.ts");
  }, 90_000);

  test("without SessionStart, the first edit creates the session and is not part of the baseline", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    hook(repo.root, {
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(repo.root, "src/a.ts") },
    });
    // The agent commits its cheat before stopping.
    repo.commit("wip");
    const out = json(hook(repo.root, { hook_event_name: "Stop" }).stdout);
    expect(out.decision).toBe("block");
    expect(String(out.reason)).toContain("type-suppression");
  });

  test("Stop without any session compares against HEAD and tells the user so", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
    repo.write("src/a.ts", `${SRC}export const y = 2;\n`);
    const out = json(hook(repo.root, { hook_event_name: "Stop" }, "late").stdout);
    expect(String(out.systemMessage)).toContain("no record of this session's start");
  });

  test("a session let go with open issues hands them to the next session", () => {
    const repo = createTempRepo({
      "package.json": "{}",
      "src/a.ts": SRC,
      "cheatguard.config.json": JSON.stringify({ hooks: { maxStopBlocks: 1 } }),
    });
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" }, "first");
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    expect(json(hook(repo.root, { hook_event_name: "Stop" }, "first").stdout).decision).toBe(
      "block",
    );
    const released = json(hook(repo.root, { hook_event_name: "Stop" }, "first").stdout);
    expect(String(released.systemMessage)).toContain("letting the agent stop");
    const start = json(
      hook(repo.root, { hook_event_name: "SessionStart", source: "startup" }, "second").stdout,
    );
    expect(JSON.stringify(start)).toContain("still checked");
    expect(json(hook(repo.root, { hook_event_name: "Stop" }, "second").stdout).decision).toBe(
      "block",
    );
  });

  test("a commit does not drop released issues (the agent can commit too); cheatguard accept does", () => {
    const repo = createTempRepo({
      "package.json": "{}",
      "src/a.ts": SRC,
      "cheatguard.config.json": JSON.stringify({ hooks: { maxStopBlocks: 1 } }),
    });
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" }, "first");
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    hook(repo.root, { hook_event_name: "Stop" }, "first");
    hook(repo.root, { hook_event_name: "Stop" }, "first");
    repo.commit("launder");
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" }, "second");
    expect(json(hook(repo.root, { hook_event_name: "Stop" }, "second").stdout).decision).toBe(
      "block",
    );
    // Agents (no TTY, CLAUDECODE=1) cannot accept on the user's behalf.
    const refused = cli(["accept"], { cwd: repo.root, env: { CLAUDECODE: "1" } });
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("person");
    const cwd = process.cwd();
    process.chdir(repo.root);
    try {
      // A wrong code is refused; the code printed on screen is accepted.
      expect(runAccept([], true, () => "000000")).toBe(1);
      let shown = "";
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: string | Uint8Array): boolean => {
        shown += String(chunk);
        return true;
      };
      try {
        expect(runAccept([], true, () => /Type (\d{6})/.exec(shown)?.[1] ?? "")).toBe(0);
      } finally {
        process.stdout.write = write;
      }
    } finally {
      process.chdir(cwd);
    }
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" }, "third");
    expect(hook(repo.root, { hook_event_name: "Stop" }, "third").stdout.trim()).toBe("");
  });

  test("a session created at its first edit does not adopt earlier Bash edits", () => {
    const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC, "src/b.ts": SRC });
    // A Bash edit before the first Edit tool call, then an edit to another file.
    repo.write("src/b.ts", SRC.replace("a: string", "a: any"));
    repo.write("src/a.ts", `${SRC}export const y = 1;\n`);
    hook(repo.root, {
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(repo.root, "src/a.ts") },
    });
    const out = json(hook(repo.root, { hook_event_name: "Stop" }).stdout);
    expect(out.decision).toBe("block");
    expect(String(out.reason)).toContain("src/b.ts");
  });
});

describe("after a release", () => {
  test("the same session is not blocked again for the issues it was released with, only for new ones", () => {
    const repo = createTempRepo({
      "package.json": "{}",
      "src/a.ts": SRC,
      "src/b.ts": SRC,
      "cheatguard.config.json": JSON.stringify({ hooks: { maxStopBlocks: 1 } }),
    });
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" }, "rel");
    repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
    expect(json(hook(repo.root, { hook_event_name: "Stop" }, "rel").stdout).decision).toBe("block");
    expect(
      String(json(hook(repo.root, { hook_event_name: "Stop" }, "rel").stdout).systemMessage),
    ).toContain("letting the agent stop");
    // Next turn, nothing new: the user is reminded, the agent is not blocked again.
    const again = json(hook(repo.root, { hook_event_name: "Stop" }, "rel").stdout);
    expect(again.decision).toBeUndefined();
    expect(String(again.systemMessage)).toContain("still open");
    // A new blocking issue blocks.
    repo.write("src/b.ts", SRC.replace("a: string", "a: any"));
    expect(json(hook(repo.root, { hook_event_name: "Stop" }, "rel").stdout).decision).toBe("block");
  });
});

describe("state and environment edges", () => {
  // Windows ignores POSIX permission bits, so the directory cannot be made read-only this way.
  test.skipIf(process.platform === "win32")(
    "an unwritable state directory still blocks with the computed findings",
    () => {
      const repo = createTempRepo({ "package.json": "{}", "src/a.ts": SRC });
      const home = join(tempNonRepoDir(), "state");
      hook(repo.root, { hook_event_name: "SessionStart", source: "startup" }, "ro");
      repo.write("src/a.ts", SRC.replace("a: string", "a: any"));
      mkdirSync(home, { recursive: true });
      chmodSync(home, 0o555);
      const env = { CHEATGUARD_STATE_HOME: home };
      const r = cli(["hook", "claude-code"], {
        cwd: repo.root,
        env,
        input: JSON.stringify({ session_id: "ro", cwd: repo.root, hook_event_name: "Stop" }),
      });
      const out = json(r.stdout);
      expect(out.decision).toBe("block");
      expect(String(out.reason)).toContain("type-suppression");
      // With stop_hook_active and no way to count, it lets the agent go and says why.
      const again = cli(["hook", "claude-code"], {
        cwd: repo.root,
        env,
        input: JSON.stringify({
          session_id: "ro",
          cwd: repo.root,
          hook_event_name: "Stop",
          stop_hook_active: true,
        }),
      });
      expect(String(json(again.stdout).systemMessage)).toContain("not writable");
      chmodSync(home, 0o755);
    },
  );

  test("a non-git folder gets one notice per session", () => {
    const dir = tempNonRepoDir();
    const first = cli(["hook", "claude-code"], {
      cwd: dir,
      input: JSON.stringify({ session_id: "ng", cwd: dir, hook_event_name: "Stop" }),
    });
    expect(String(json(first.stdout).systemMessage)).toContain("not a git repository");
    const second = cli(["hook", "claude-code"], {
      cwd: dir,
      input: JSON.stringify({ session_id: "ng", cwd: dir, hook_event_name: "Stop" }),
    });
    expect(second.stdout.trim()).toBe("");
  });

  test("a session id that looks like an option still gets its lint baseline", () => {
    const repo = tsRepo();
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" }, "--help");
    waitForLintBaseline(repo.root, "--help");
  }, 90_000);

  test("the background baseline reads the config of the session baseline, not HEAD", () => {
    const repo = tsRepo({ lint: { onEdit: [], onStop: [] } });
    hook(repo.root, { hook_event_name: "SessionStart", source: "startup" });
    const session = loadSession(repo.root, "life");
    expect(session?.tools).toEqual([]);
    expect(existsSync(join(stateDir(repo.root), "sessions", "life.lint.pending"))).toBe(false);
    if (session) saveSession(repo.root, session);
    expect(readFileSync(join(repo.root, "cheatguard.config.json"), "utf8")).toContain("onStop");
  });
});
