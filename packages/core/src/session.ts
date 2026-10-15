import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { snapshotWorkingTree, sparseEntries } from "./git/index.js";
import type { LintBaseline } from "./lint/index.js";
import { canonicalPath } from "./realpath.js";
import { LINT_TOOLS, type LintToolName } from "./types.js";

export interface SessionState {
  id: string;
  /** Tree of the working directory when the session started: changes before it are not the agent's. */
  baselineTree: string;
  createdAt: string;
  /** Consecutive Stop hooks blocked in a row (reset when a Stop passes). */
  stopBlocks: number;
  /** Linters that could run when the session started: if one stops working, Stop says so. */
  tools: LintToolName[];
  /** Warnings already shown to the agent at Stop (each is shown once). */
  warned: string[];
  /** True when the baseline was carried over from a session that was let go with open issues. */
  carriedOver: boolean;
  /** Sparse-checkout paths absent from disk at session start (the only ones allowed to be missing). */
  sparse: string[];
  /** Blocking issues the agent was let go with (anti-loop): they do not block this session again. */
  released: string[];
}

export type LintStatus = "none" | "pending" | "ready";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const lintTools = (value: unknown): LintToolName[] =>
  strings(value).filter((v): v is LintToolName => (LINT_TOOLS as readonly string[]).includes(v));

const TREE_RE = /^[0-9a-f]{40,64}$/;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function safeId(id: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
    ? id
    : createHash("sha256").update(id).digest("hex").slice(0, 32);
}

function stateHome(): string {
  if (process.env.CHEATGUARD_STATE_HOME) return process.env.CHEATGUARD_STATE_HOME;
  if (process.platform === "win32")
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
}

/**
 * Per-repository state directory, kept outside the working tree so the agent being checked
 * does not see (or edit) the baseline and counters as part of the project.
 */
export function stateDir(root: string): string {
  let real = root;
  try {
    real = canonicalPath(root);
  } catch {
    // keep the given path
  }
  const id = createHash("sha256").update(real).digest("hex").slice(0, 16);
  return join(stateHome(), "cheatguard", id);
}

function sessionFile(root: string, id: string, suffix = ".json"): string {
  return join(stateDir(root), "sessions", `${safeId(id)}${suffix}`);
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function loadSession(root: string, id: string): SessionState | null {
  const parsed = readJson(sessionFile(root, id));
  if (!isRecord(parsed)) return null;
  if (typeof parsed.baselineTree !== "string" || !TREE_RE.test(parsed.baselineTree)) return null;
  return {
    id,
    baselineTree: parsed.baselineTree,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
    stopBlocks: typeof parsed.stopBlocks === "number" ? parsed.stopBlocks : 0,
    tools: lintTools(parsed.tools),
    warned: strings(parsed.warned),
    carriedOver: parsed.carriedOver === true,
    sparse: strings(parsed.sparse),
    released: strings(parsed.released),
  };
}

export function saveSession(root: string, state: SessionState): void {
  writeAtomic(sessionFile(root, state.id), `${JSON.stringify(state, null, 2)}\n`);
}

export interface StartOptions {
  resume: boolean;
  baselineTree?: string;
  tools?: LintToolName[];
  carriedOver?: boolean;
}

/** Builds a session (or, on resume, returns the existing one). Does not write it: see saveSession. */
export function newSession(root: string, id: string, options: StartOptions): SessionState {
  const existing = loadSession(root, id);
  if (existing && options.resume) return existing;
  const sparse = sparseEntries(root);
  return {
    id,
    // A session created late (no SessionStart) must not adopt the agent's edits as its baseline.
    baselineTree: options.baselineTree ?? snapshotWorkingTree(root, { sparse: new Set(sparse) }),
    createdAt: new Date().toISOString(),
    stopBlocks: 0,
    tools: options.tools ?? [],
    warned: [],
    carriedOver: options.carriedOver ?? false,
    sparse,
    released: [],
  };
}

/** Starts (or, on resume, keeps) a session and records the working-tree baseline. */
export function startSession(root: string, id: string, options: StartOptions): SessionState {
  const state = newSession(root, id, options);
  saveSession(root, state);
  return state;
}

/** Lint baselines older than this while still "pending" are treated as lost (crashed job). */
const PENDING_TTL_MS = 15 * 60 * 1000;

/** Lint baseline state lives in its own files, so a Stop hook can never overwrite it. */
export function lintStatus(root: string, id: string): LintStatus {
  if (existsSync(sessionFile(root, id, ".lint.json"))) return "ready";
  const pending = sessionFile(root, id, ".lint.pending");
  try {
    return Date.now() - statSync(pending).mtimeMs < PENDING_TTL_MS ? "pending" : "none";
  } catch {
    return "none";
  }
}

export function markLintPending(root: string, id: string): void {
  writeAtomic(sessionFile(root, id, ".lint.pending"), new Date().toISOString());
}

export function saveLintBaseline(root: string, id: string, baseline: LintBaseline): void {
  writeAtomic(sessionFile(root, id, ".lint.json"), JSON.stringify(baseline));
  rmSync(sessionFile(root, id, ".lint.pending"), { force: true });
}

export function loadLintBaseline(root: string, id: string): LintBaseline | null {
  const parsed = readJson(sessionFile(root, id, ".lint.json"));
  if (!isRecord(parsed) || !Array.isArray(parsed.fingerprints)) return null;
  return {
    tools: lintTools(parsed.tools),
    fingerprints: strings(parsed.fingerprints),
    errors: strings(parsed.errors),
    dirtyFiles: strings(parsed.dirtyFiles),
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
  };
}

/** A session that was let go with blocking issues still open (anti-loop release). */
export interface Release {
  session: string;
  baselineTree: string;
  /** HEAD commit when the session was released ("" for an unborn branch). */
  head: string;
  time: string;
}

const releaseFile = (root: string): string => join(stateDir(root), "released.json");

export function saveRelease(root: string, release: Release): void {
  writeAtomic(releaseFile(root), JSON.stringify(release));
}

export function loadRelease(root: string): Release | null {
  const parsed = readJson(releaseFile(root));
  if (!isRecord(parsed)) return null;
  const { session, baselineTree, head, time } = parsed;
  if (typeof baselineTree !== "string" || !TREE_RE.test(baselineTree)) return null;
  return {
    session: typeof session === "string" ? session : "",
    baselineTree,
    head: typeof head === "string" ? head : "",
    time: typeof time === "string" ? time : "",
  };
}

export function clearRelease(root: string): void {
  rmSync(releaseFile(root), { force: true });
}

export function logError(root: string, error: unknown): void {
  try {
    mkdirSync(stateDir(root), { recursive: true });
    const message =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
        : String(error);
    appendFileSync(
      join(stateDir(root), "errors.log"),
      `[${new Date().toISOString()}] ${message}\n`,
    );
  } catch {
    // Logging must never throw from a fail-open path.
  }
}

export interface Intervention {
  time: string;
  session: string;
  event: string;
  /** "block" stopped the agent; "context" informed it; "released" let it stop after maxStopBlocks. */
  decision: "block" | "context" | "released";
  rules: string[];
  files: string[];
}

/** Appends one push-back to the per-repository audit log (interventions.jsonl in the state dir). */
export function logIntervention(root: string, entry: Omit<Intervention, "time">): void {
  try {
    mkdirSync(stateDir(root), { recursive: true });
    appendFileSync(
      join(stateDir(root), "interventions.jsonl"),
      `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`,
    );
  } catch (error) {
    // The audit log is best effort and must never break a hook; keep a trace of the failure.
    logError(root, error);
  }
}

const DECISIONS = new Set(["block", "context", "released"]);

function asIntervention(value: unknown): Intervention | null {
  if (!isRecord(value)) return null;
  const { time, session, event, decision, rules, files } = value;
  if (typeof decision !== "string" || !DECISIONS.has(decision)) return null;
  return {
    time: typeof time === "string" ? time : "",
    session: typeof session === "string" ? session : "",
    event: typeof event === "string" ? event : "",
    decision: decision === "block" ? "block" : decision === "context" ? "context" : "released",
    rules: strings(rules),
    files: strings(files),
  };
}

export function readInterventions(root: string): Intervention[] {
  const path = join(stateDir(root), "interventions.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const entry = asIntervention(JSON.parse(line));
        return entry ? [entry] : [];
      } catch {
        return [];
      }
    });
}
