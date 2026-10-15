import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  loadLintBaseline,
  loadSession,
  logError,
  saveLintBaseline,
  saveSession,
  startSession,
  stateDir,
} from "../src/session.js";
import { createTempRepo } from "./helpers/repo.js";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env.CHEATGUARD_STATE_HOME;
  process.env.CHEATGUARD_STATE_HOME = mkdtempSync(join(tmpdir(), "cg-state-"));
});
afterEach(() => {
  if (previous === undefined) delete process.env.CHEATGUARD_STATE_HOME;
  else process.env.CHEATGUARD_STATE_HOME = previous;
});

describe("sessions", () => {
  test("state lives outside the repository, per repository", () => {
    const a = createTempRepo({ "a.ts": "1\n" });
    const b = createTempRepo({ "a.ts": "1\n" });
    expect(stateDir(a.root).startsWith(a.root)).toBe(false);
    expect(stateDir(a.root)).not.toBe(stateDir(b.root));
  });

  test("every spelling of the repository path maps to the same state", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    // git prints C:/Users/... on Windows while temp paths use backslashes (and 8.3 names).
    expect(stateDir(repo.root.replace(/\\/g, "/"))).toBe(stateDir(repo.root));
    expect(stateDir(`${repo.root}/`)).toBe(stateDir(repo.root));
  });

  test("start records a baseline; resume keeps it; a fresh start replaces it", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    const first = startSession(repo.root, "s1", { resume: false });
    repo.write("a.ts", "2\n");
    expect(startSession(repo.root, "s1", { resume: true }).baselineTree).toBe(first.baselineTree);
    expect(startSession(repo.root, "s1", { resume: false }).baselineTree).not.toBe(
      first.baselineTree,
    );
  });

  test("an explicit baseline is used as is", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    const head = repo.git("rev-parse", "HEAD^{tree}").trim();
    repo.write("a.ts", "2\n");
    expect(startSession(repo.root, "late", { resume: true, baselineTree: head }).baselineTree).toBe(
      head,
    );
  });

  test("save and load round-trip; unknown sessions are null", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    const s = startSession(repo.root, "s2", { resume: false });
    saveSession(repo.root, { ...s, stopBlocks: 2, tools: ["tsc"], warned: ["k"] });
    expect(loadSession(repo.root, "s2")).toMatchObject({
      stopBlocks: 2,
      tools: ["tsc"],
      warned: ["k"],
      baselineTree: s.baselineTree,
    });
    expect(loadSession(repo.root, "nope")).toBeNull();
  });

  test("odd session ids are hashed into safe file names", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    const s = startSession(repo.root, "../../etc/passwd", { resume: false });
    expect(loadSession(repo.root, "../../etc/passwd")?.baselineTree).toBe(s.baselineTree);
  });

  test("corrupt or invalid session files are ignored", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    startSession(repo.root, "s3", { resume: false });
    writeFileSync(join(stateDir(repo.root), "sessions", "s3.json"), "{ nope");
    expect(loadSession(repo.root, "s3")).toBeNull();
    writeFileSync(
      join(stateDir(repo.root), "sessions", "s3.json"),
      JSON.stringify({ baselineTree: "not-a-sha" }),
    );
    expect(loadSession(repo.root, "s3")).toBeNull();
    writeFileSync(
      join(stateDir(repo.root), "sessions", "s3.json"),
      JSON.stringify({ baselineTree: "a".repeat(40) }),
    );
    expect(loadSession(repo.root, "s3")).toMatchObject({ stopBlocks: 0, tools: [], warned: [] });
  });

  test("lint baselines round-trip and tolerate garbage", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    expect(loadLintBaseline(repo.root, "s4")).toBeNull();
    saveLintBaseline(repo.root, "s4", {
      tools: ["tsc"],
      fingerprints: ["x", "y"],
      errors: [],
      dirtyFiles: ["a.ts"],
      createdAt: "now",
    });
    expect(loadLintBaseline(repo.root, "s4")?.fingerprints).toEqual(["x", "y"]);
    expect(loadLintBaseline(repo.root, "s4")?.dirtyFiles).toEqual(["a.ts"]);
    writeFileSync(join(stateDir(repo.root), "sessions", "s4.lint.json"), "garbage");
    expect(loadLintBaseline(repo.root, "s4")).toBeNull();
  });

  test("errors are appended to errors.log", () => {
    const repo = createTempRepo({ "a.ts": "1\n" });
    logError(repo.root, new Error("boom"));
    logError(repo.root, "plain string");
    const log = readFileSync(join(stateDir(repo.root), "errors.log"), "utf8");
    expect(log).toContain("Error: boom");
    expect(log).toContain("plain string");
  });
});

describe("intervention log", () => {
  test("records every push-back as a JSON line", async () => {
    const { logIntervention, readInterventions } = await import("../src/session.js");
    const repo = createTempRepo({ "a.ts": "1\n" });
    logIntervention(repo.root, {
      session: "s1",
      event: "PostToolUse",
      decision: "block",
      rules: ["test-weakened"],
      files: ["a.test.ts"],
    });
    logIntervention(repo.root, {
      session: "s1",
      event: "Stop",
      decision: "context",
      rules: ["swallowed-error"],
      files: ["a.ts"],
    });
    const entries = readInterventions(repo.root);
    expect(entries.map((e) => [e.event, e.decision, e.rules.join(",")])).toEqual([
      ["PostToolUse", "block", "test-weakened"],
      ["Stop", "context", "swallowed-error"],
    ]);
    expect(typeof entries[0]?.time).toBe("string");
  });
});

describe("lint baseline status and releases", () => {
  test("pending → ready lives in its own files, so session writes cannot clobber it", async () => {
    const { lintStatus, markLintPending } = await import("../src/session.js");
    const repo = createTempRepo({ "a.ts": "1\n" });
    const s = startSession(repo.root, "p1", { resume: false });
    expect(lintStatus(repo.root, "p1")).toBe("none");
    markLintPending(repo.root, "p1");
    expect(lintStatus(repo.root, "p1")).toBe("pending");
    saveLintBaseline(repo.root, "p1", {
      tools: [],
      fingerprints: [],
      errors: [],
      dirtyFiles: [],
      createdAt: "",
    });
    // A Stop hook saving a stale copy of the session does not change the lint status.
    saveSession(repo.root, { ...s, stopBlocks: 1 });
    expect(lintStatus(repo.root, "p1")).toBe("ready");
  });

  test("releases round-trip and can be cleared", async () => {
    const { saveRelease, loadRelease, clearRelease } = await import("../src/session.js");
    const repo = createTempRepo({ "a.ts": "1\n" });
    expect(loadRelease(repo.root)).toBeNull();
    saveRelease(repo.root, { session: "s", baselineTree: "b".repeat(40), head: "h", time: "t" });
    expect(loadRelease(repo.root)?.baselineTree).toBe("b".repeat(40));
    clearRelease(repo.root);
    expect(loadRelease(repo.root)).toBeNull();
  });

  test("malformed audit log lines are skipped", async () => {
    const { readInterventions } = await import("../src/session.js");
    const repo = createTempRepo({ "a.ts": "1\n" });
    mkdirSync(stateDir(repo.root), { recursive: true });
    writeFileSync(
      join(stateDir(repo.root), "interventions.jsonl"),
      `${JSON.stringify({ decision: "nope" })}\n42\n${JSON.stringify({ decision: "block", rules: [1, "x"] })}\n`,
    );
    expect(readInterventions(repo.root).map((e) => e.rules)).toEqual([["x"]]);
  });
});

describe("audit log failures", () => {
  test("a failing audit log write is recorded in errors.log instead of throwing", async () => {
    const { logIntervention } = await import("../src/session.js");
    const repo = createTempRepo({ "a.ts": "1\n" });
    mkdirSync(join(stateDir(repo.root), "interventions.jsonl"), { recursive: true });
    expect(() =>
      logIntervention(repo.root, {
        session: "s",
        event: "Stop",
        decision: "block",
        rules: [],
        files: [],
      }),
    ).not.toThrow();
    expect(readFileSync(join(stateDir(repo.root), "errors.log"), "utf8")).toContain("EISDIR");
  });
});
