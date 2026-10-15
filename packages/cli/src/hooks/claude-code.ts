import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type CheatguardConfig,
  canonicalPath,
  check,
  checkFile,
  clearRelease,
  formatHook,
  headCommit,
  type LintBaseline,
  type LintResult,
  type LintToolName,
  lintStatus,
  loadConfigAt,
  loadLintBaseline,
  loadRelease,
  loadSession,
  logError,
  logIntervention,
  markLintPending,
  NotAGitRepoError,
  newSession,
  planTools,
  type Report,
  repoRoot,
  resolveTree,
  runLint,
  type SessionState,
  saveRelease,
  saveSession,
  stateDir,
  summarize,
  type ToolPlan,
  type ToolProblem,
} from "@cheatguard/core";

interface HookPayload {
  sessionId: string;
  cwd: string;
  event: string;
  source: string | null;
  toolName: string | null;
  filePath: string | null;
  stopHookActive: boolean;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parsePayload(raw: string): HookPayload {
  const data: unknown = JSON.parse(raw);
  if (!isRecord(data)) throw new Error("hook payload is not an object");
  const toolInput = isRecord(data.tool_input) ? data.tool_input : {};
  return {
    sessionId: str(data.session_id) ?? "default",
    cwd: str(data.cwd) ?? process.cwd(),
    event: str(data.hook_event_name) ?? "",
    source: str(data.source),
    toolName: str(data.tool_name),
    filePath: str(toolInput.file_path) ?? str(toolInput.notebook_path),
    stopHookActive: data.stop_hook_active === true,
  };
}

function emit(output: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

/** Emits a hook response and records it in the audit log. */
function respond(
  root: string,
  payload: HookPayload,
  report: Report,
  decision: "block" | "context" | "released",
  output: Record<string, unknown>,
): void {
  const rules = [
    ...new Set([
      ...report.check.violations.map((v) => v.rule),
      ...(report.lint?.newDiagnostics.length ? ["lint"] : []),
      ...(report.toolProblems?.length ? ["lint-tool"] : []),
    ]),
  ];
  const files = [
    ...new Set([
      ...report.check.violations.map((v) => v.file),
      ...(report.lint?.newDiagnostics.map((d) => d.file) ?? []),
    ]),
  ];
  logIntervention(root, {
    session: payload.sessionId,
    event: payload.event,
    decision,
    rules,
    files,
  });
  emit(output);
}

/** Saving state is best effort: a read-only state directory must not discard computed findings. */
function persist(root: string, state: SessionState): boolean {
  try {
    saveSession(root, state);
    return true;
  } catch (error) {
    logError(root, error);
    return false;
  }
}

function real(path: string): string {
  try {
    return canonicalPath(path);
  } catch {
    // The file may have been deleted by the tool; resolve its directory instead.
    const dir = dirname(path);
    return existsSync(dir)
      ? resolve(canonicalPath(dir), path.slice(dir.length + 1))
      : resolve(path);
  }
}

/** Repo-relative POSIX path, or null when the file is outside the repository. */
function repoPath(root: string, file: string): string | null {
  const rel = relative(real(root), real(isAbsolute(file) ? file : resolve(root, file)));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

const inPhase = (tools: readonly LintToolName[], phase: readonly LintToolName[]): LintToolName[] =>
  tools.filter((t) => phase.includes(t));

function hookTools(config: CheatguardConfig, plan: ToolPlan): LintToolName[] {
  return inPhase(plan.tools, [...new Set([...config.lint.onEdit, ...config.lint.onStop])]);
}

/** Records the lint baseline in the background (it can take seconds) so the session starts instantly. */
function startLintBaseline(root: string, session: SessionState): void {
  if (session.tools.length === 0) return;
  const script = process.argv[1];
  if (!script) return;
  try {
    markLintPending(root, session.id);
  } catch (error) {
    logError(root, error);
    return;
  }
  // "--opt=value" keeps a session id that starts with "-" from being read as an option.
  const child = spawn(process.execPath, [script, "lint", `--snapshot-session=${session.id}`], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function sessionStart(root: string, payload: HookPayload): void {
  const resume = payload.source === "resume" || payload.source === "compact";
  const existing = loadSession(root, payload.sessionId);
  if (existing && resume) return;
  // A session that was let go with blocking issues open hands its baseline to the next one until a
  // person runs `cheatguard accept` (a commit is not enough: the agent can commit too).
  const carry = loadRelease(root);
  const options = carry
    ? { resume: false, baselineTree: carry.baselineTree, carriedOver: true }
    : { resume: false };
  const session = newSession(root, payload.sessionId, options);
  const config = loadConfigAt(root, session.baselineTree);
  session.tools = hookTools(config, planTools(root, config));
  if (persist(root, session)) startLintBaseline(root, session);
  if (carry) {
    emit({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "cheatguard: a previous session in this repository ended with blocking issues still open. They are still checked in this session: fix them before finishing (a person can run `cheatguard accept` to drop them).",
      },
    });
  }
}

/**
 * The session, created at its first edit when SessionStart never ran (e.g. the plugin was still
 * installing). Its baseline is HEAD as of now: earlier edits (even Bash ones) are not adopted, and
 * commits made later in the session cannot hide anything.
 */
function sessionForEdit(root: string, payload: HookPayload): SessionState {
  const existing = loadSession(root, payload.sessionId);
  if (existing) return existing;
  const baselineTree = resolveTree(root, "HEAD");
  const session = newSession(root, payload.sessionId, { resume: false, baselineTree });
  const config = loadConfigAt(root, baselineTree);
  session.tools = hookTools(config, planTools(root, config));
  if (persist(root, session)) startLintBaseline(root, session);
  return session;
}

function lintBaseline(root: string, session: SessionState): LintBaseline | null {
  return lintStatus(root, session.id) === "ready" ? loadLintBaseline(root, session.id) : null;
}

function postToolUse(root: string, payload: HookPayload): void {
  if (!payload.toolName || !EDIT_TOOLS.has(payload.toolName) || !payload.filePath) return;
  const path = repoPath(root, payload.filePath);
  if (!path) return;
  const session = sessionForEdit(root, payload);
  const config = loadConfigAt(root, session.baselineTree);
  const result = checkFile({ root, baseTree: session.baselineTree, path, config });
  let lint: LintResult | undefined;
  const tools = inPhase(planTools(root, config).tools, config.lint.onEdit).filter(
    (t) => t !== "tsc",
  );
  if (tools.length > 0 && result.changes.length > 0) {
    const baseline = lintBaseline(root, session);
    lint = runLint({
      root,
      tools,
      changes: result.changes,
      baseline: baseline?.fingerprints ?? null,
      dirtyFiles: baseline?.dirtyFiles ?? [],
    });
  }
  const toolProblems: ToolProblem[] = (lint?.tools ?? [])
    .filter((t) => !t.ok)
    .map((t) => ({ tool: t.tool, error: t.error ?? "unknown error", blocking: false }));
  const report: Report = {
    check: result,
    maxDiagnostics: config.lint.maxDiagnostics,
    toolProblems,
  };
  if (lint) report.lint = lint;
  const summary = summarize(report);
  if (summary.block > 0) {
    respond(root, payload, report, "block", {
      decision: "block",
      reason: formatHook(report, { blocking: true }),
    });
  } else if (summary.warn > 0 || summary.lintNew > 0 || toolProblems.length > 0) {
    respond(root, payload, report, "context", {
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: formatHook(report) },
    });
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Stop is not latency-critical: give a still-running lint baseline a chance to finish. */
function waitForBaseline(root: string, session: SessionState, seconds: number): void {
  const deadline = Date.now() + seconds * 1000;
  while (lintStatus(root, session.id) === "pending" && Date.now() < deadline) sleep(250);
}

/** Linters that worked at session start (or are required by config) but cannot run now. */
function toolProblemsAtStop(
  config: CheatguardConfig,
  session: SessionState,
  plan: ToolPlan,
  lint: LintResult | undefined,
  baseline: LintBaseline | null,
): ToolProblem[] {
  const problems: ToolProblem[] = [];
  const reason = (tool: LintToolName): string =>
    plan.missing.find((m) => m.tool === tool)?.reason ?? `${tool} is no longer available`;
  for (const tool of inPhase(session.tools, config.lint.onStop)) {
    if (!plan.tools.includes(tool)) problems.push({ tool, error: reason(tool), blocking: true });
  }
  for (const missing of plan.missing) {
    if (!missing.required || !config.lint.onStop.includes(missing.tool)) continue;
    if (problems.some((p) => p.tool === missing.tool)) continue;
    problems.push({ tool: missing.tool, error: missing.reason, blocking: true });
  }
  const required = config.lint.tools === "auto" ? [] : config.lint.tools;
  for (const run of lint?.tools ?? []) {
    if (run.ok) continue;
    // A failure blocks only when the tool provably worked when the session started (or is required):
    // a linter that was already broken is the project's problem, not the agent's.
    const workedAtStart =
      baseline?.tools.includes(run.tool) === true &&
      !baseline.errors.some((e) => e.startsWith(`${run.tool}:`));
    problems.push({
      tool: run.tool,
      error: run.error ?? "unknown error",
      blocking: workedAtStart || required.includes(run.tool),
    });
  }
  return problems;
}

const issueKey = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

const warningKey = (v: { rule: string; file: string; detail: string }): string =>
  issueKey(`${v.rule}\0${v.file}\0${v.detail}`);

/** Keys of everything that blocks this Stop (violations, lint errors, broken linters). */
function blockingKeys(report: Report, config: CheatguardConfig): string[] {
  const keys = report.check.violations
    .filter((v) => v.severity === "block")
    .map((v) => issueKey(`v\0${v.rule}\0${v.file}\0${v.detail}`));
  if (config.lint.blockOnStop) {
    for (const d of report.lint?.newDiagnostics ?? []) {
      if (d.severity === "error")
        keys.push(issueKey(`l\0${d.tool}\0${d.file}\0${d.code}\0${d.message}`));
    }
  }
  for (const p of report.toolProblems ?? []) {
    if (p.blocking) keys.push(issueKey(`t\0${p.tool}\0${p.error}`));
  }
  return keys;
}

const NO_SESSION_NOTE =
  "cheatguard had no record of this session's start (its SessionStart hook did not run), so it compared against HEAD: anything committed during the session was not checked.";

function stop(root: string, payload: HookPayload): void {
  const loaded = loadSession(root, payload.sessionId);
  const session =
    loaded ??
    newSession(root, payload.sessionId, {
      resume: false,
      baselineTree: resolveTree(root, "HEAD"),
      tools: [],
    });
  const config = loadConfigAt(root, session.baselineTree);
  waitForBaseline(root, session, config.hooks.baselineWaitSeconds);
  const result = check({
    root,
    base: { tree: session.baselineTree },
    head: "worktree",
    config,
    sparse: new Set(session.sparse),
  });
  const plan = planTools(root, config);
  const baseline = lintBaseline(root, session);
  let lint: LintResult | undefined;
  const tools = inPhase(plan.tools, config.lint.onStop);
  if (tools.length > 0 && result.changes.length > 0) {
    lint = runLint({
      root,
      tools,
      changes: result.changes,
      baseline: baseline?.fingerprints ?? null,
      dirtyFiles: baseline?.dirtyFiles ?? [],
    });
  }
  const report: Report = {
    check: result,
    maxDiagnostics: config.lint.maxDiagnostics,
    toolProblems: toolProblemsAtStop(config, session, plan, lint, baseline),
  };
  if (lint) report.lint = lint;
  const summary = summarize(report);
  const keys = blockingKeys(report, config);
  // Issues the agent was already let go with (anti-loop) do not block again in this session.
  const fresh = keys.filter((k) => !session.released.includes(k));
  const blocking = fresh.length > 0;
  const stillOpen = keys.length - fresh.length;
  const note = loaded ? {} : { systemMessage: NO_SESSION_NOTE };

  if (!blocking) {
    const unseen = report.check.violations
      .filter((v) => v.severity === "warn")
      .map(warningKey)
      .filter((key) => !session.warned.includes(key));
    if (config.hooks.warnAgentOnStop && unseen.length > 0) {
      const saved = persist(root, { ...session, warned: [...session.warned, ...unseen] });
      // Without saved state the warning would repeat forever; Claude Code's stop_hook_active ends it.
      if (saved || !payload.stopHookActive) {
        respond(root, payload, report, "context", {
          decision: "block",
          reason: formatHook(report, {
            heading:
              "cheatguard: before you finish, look at these warnings. Fix them, or if each one is intended, say why in one line and stop again (you will not be asked about them again):",
          }),
          ...note,
        });
        return;
      }
    }
    if (session.stopBlocks !== 0 || !loaded || (keys.length === 0 && session.released.length > 0)) {
      persist(root, {
        ...session,
        stopBlocks: 0,
        released: keys.length === 0 ? [] : session.released,
      });
    }
    if (session.carriedOver && keys.length === 0) {
      try {
        clearRelease(root);
      } catch (error) {
        logError(root, error);
      }
    }
    const details =
      summary.warn > 0 || summary.lintNew > 0 || (report.toolProblems ?? []).length > 0;
    if (details || !loaded || stillOpen > 0) {
      const reminder =
        stillOpen > 0
          ? `cheatguard: ${stillOpen} blocking issue${stillOpen === 1 ? " is" : "s are"} still open from when the agent was let go; review them before merging.`
          : "";
      const message = [reminder, details ? formatHook(report) : "", loaded ? "" : NO_SESSION_NOTE]
        .filter(Boolean)
        .join("\n\n");
      respond(root, payload, report, "context", { systemMessage: message });
    }
    return;
  }

  const release = (why: string): void => {
    try {
      saveRelease(root, {
        session: session.id,
        baselineTree: session.baselineTree,
        head: headCommit(root),
        time: new Date().toISOString(),
      });
    } catch (error) {
      logError(root, error);
    }
    persist(root, {
      ...session,
      stopBlocks: 0,
      released: [...new Set([...session.released, ...keys])],
    });
    respond(root, payload, report, "released", {
      systemMessage: `cheatguard: ${why}; letting the agent stop. Review these issues; the next sessions keep checking them until you run \`cheatguard accept\`:\n${formatHook(report, { blocking: true })}`,
    });
  };
  if (session.stopBlocks >= config.hooks.maxStopBlocks) {
    release(`issues remain unresolved after ${config.hooks.maxStopBlocks} attempts`);
    return;
  }
  const saved = persist(root, { ...session, stopBlocks: session.stopBlocks + 1 });
  if (!saved && payload.stopHookActive) {
    // The block counter cannot be stored, so the anti-loop limit cannot work: stop after one retry.
    release("its state directory is not writable, so it cannot count attempts");
    return;
  }
  respond(root, payload, report, "block", {
    decision: "block",
    reason: formatHook(report, { blocking: true }),
    ...note,
  });
}

function remember(path: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    return true;
  } catch {
    return false;
  }
}

/** Non-git folders get one notice per session, not one per Stop. */
function notifyNotARepo(cwd: string, sessionId: string): void {
  const marker = join(
    stateDir(cwd),
    "not-a-repo",
    createHash("sha256").update(sessionId).digest("hex").slice(0, 32),
  );
  if (existsSync(marker)) return;
  // Without the marker the notice may repeat on the next Stop; it is still shown now.
  if (!remember(marker)) process.stderr.write("cheatguard: could not record the notice\n");
  emit({
    systemMessage:
      "cheatguard: this folder is not a git repository, so the agent's changes here are not checked.",
  });
}

/** Entry point for `cheatguard hook claude-code`. Always exits 0: a broken guard must never brick the agent. */
export function runClaudeCodeHook(raw: string): number {
  let root: string | null = null;
  let payload: HookPayload | null = null;
  try {
    payload = parsePayload(raw);
    root = repoRoot(payload.cwd);
    if (payload.event === "SessionStart") sessionStart(root, payload);
    else if (payload.event === "PostToolUse") postToolUse(root, payload);
    else if (payload.event === "Stop" || payload.event === "SubagentStop") stop(root, payload);
  } catch (error) {
    const event = payload?.event ?? "";
    const isStop = event === "Stop" || event === "SubagentStop";
    if (error instanceof NotAGitRepoError && payload) {
      if (isStop) notifyNotARepo(payload.cwd, payload.sessionId);
      return 0;
    }
    if (root === null) {
      try {
        root = repoRoot(process.cwd());
      } catch {
        root = null;
      }
    }
    if (root) logError(root, error);
    if (isStop) {
      // Never silent: the user must know the change was not verified.
      const message = error instanceof Error ? error.message : String(error);
      emit({
        systemMessage: `cheatguard could not check this change (${message.split("\n")[0]}). The agent was allowed to stop; review the diff manually.`,
      });
    }
  }
  return 0;
}
