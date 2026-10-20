import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import ts from "typescript";
import type { LintToolName } from "../types.js";
import { asArray, isRecord } from "../util/json.js";
import { toolScript } from "./detect.js";
import { parseBiomeGithub, parseEslintJson, parseOxlintJson, parseTscOutput } from "./parsers.js";
import { workspaceTsconfigs } from "./projects.js";
import type { Diagnostic } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 120_000;

export interface ToolOutput {
  diagnostics: Diagnostic[];
  rawChars: number;
  durationMs: number;
  error?: string;
}

/** Repo paths as arguments: "./" keeps a file named "--config=x.mjs" from being read as an option. */
export function asPathArgs(files: readonly string[]): string[] {
  return files.map((f) => (f.startsWith("./") || f.startsWith("../") ? f : `./${f}`));
}

interface NodeResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: string;
}

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

function runNode(
  root: string,
  script: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<NodeResult> {
  return new Promise((resolve) => {
    // No shell on any platform: arguments reach node verbatim.
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      timeout: timeoutMs,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let error: string | undefined;
    let settled = false;
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      const result: NodeResult = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        status,
      };
      if (error !== undefined) result.error = error;
      resolve(result);
    };
    const collect =
      (chunks: Buffer[]) =>
      (chunk: Buffer): void => {
        size += chunk.length;
        if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk);
        else if (error === undefined) {
          error = `${basename(script)} printed more than ${MAX_OUTPUT_BYTES / 1024 / 1024} MB`;
          child.kill();
        }
      };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (e) => {
      error ??= e.message;
      // A process that never started emits no "close".
      if (child.pid === undefined) finish(null);
    });
    child.on("close", (status, signal) => {
      if (signal !== null && error === undefined) {
        error = child.killed
          ? `${basename(script)} timed out after ${Math.round(timeoutMs / 1000)} s`
          : `${basename(script)} was killed by ${signal}`;
      }
      finish(status);
    });
  });
}

/** tsc projects checked at the same time (each is its own process and can use a lot of memory). */
const TSC_CONCURRENCY = Math.max(1, Math.min(4, availableParallelism() - 1));

/** Like Promise.all over `items.map(fn)`, with at most `limit` calls running at once. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Files a tsconfig project compiles (tsc's own include/exclude expansion), relative to the root. */
function projectFiles(root: string, project: string): string[] {
  const path = join(root, project);
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error) return [];
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path), undefined, path);
  return parsed.fileNames.map((f) => relative(root, f).split(sep).join("/"));
}

/**
 * tsconfig projects to check: the root one (or, for a solution-style config, only its references)
 * plus its references, since `tsc -p` does not check referenced projects. Workspace packages with a
 * tsconfig that none of those projects compiles are added too (a root config that includes only
 * scripts would otherwise leave every package unchecked).
 */
export function tsconfigProjects(root: string): string[] {
  const workspaces = workspaceTsconfigs(root);
  const path = join(root, "tsconfig.json");
  // Monorepos without a root tsconfig: check every workspace package that has one.
  if (!existsSync(path)) return workspaces;
  const config: unknown = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8")).config;
  const parsed = isRecord(config) ? config : {};
  const references = asArray(parsed.references)
    .map((r) => (isRecord(r) && typeof r.path === "string" ? r.path : ""))
    .filter(Boolean)
    .map((p: string) => (p.endsWith(".json") ? p : posix.join(p, "tsconfig.json")));
  const solution =
    references.length > 0 &&
    Array.isArray(parsed.files) &&
    parsed.files.length === 0 &&
    parsed.include === undefined;
  const projects = solution ? references : ["tsconfig.json", ...references];
  if (workspaces.length === 0) return projects;
  const selected = new Set(projects.map((p) => posix.normalize(p)));
  const covered = projects.flatMap((p) => projectFiles(root, p));
  for (const workspace of workspaces) {
    const dir = `${posix.dirname(workspace)}/`;
    if (selected.has(workspace) || covered.some((f) => f.startsWith(dir))) continue;
    projects.push(workspace);
  }
  return projects;
}

export async function runTool(
  root: string,
  tool: LintToolName,
  files: readonly string[] | "all",
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ToolOutput> {
  const start = performance.now();
  const bin = toolScript(root, tool);
  if (!bin)
    return { diagnostics: [], rawChars: 0, durationMs: 0, error: `${tool} is not installed` };
  const targets = files === "all" ? ["."] : asPathArgs(files);
  const done = (diagnostics: Diagnostic[], rawChars: number, error?: string): ToolOutput => {
    const output: ToolOutput = { diagnostics, rawChars, durationMs: performance.now() - start };
    if (error) output.error = error;
    return output;
  };
  try {
    if (tool === "eslint") {
      let result = await runNode(
        root,
        bin,
        ["--format", "json", "--no-warn-ignored", ...targets],
        timeoutMs,
      );
      if (result.status === 2 && /no-warn-ignored/.test(result.stderr)) {
        result = await runNode(root, bin, ["--format", "json", ...targets], timeoutMs);
      }
      if (result.error) return done([], 0, result.error);
      if (result.status === 2 || !result.stdout.trim()) {
        return done(
          [],
          result.stdout.length,
          (result.stderr || result.stdout).trim().split("\n").slice(0, 3).join(" ") ||
            "ESLint failed",
        );
      }
      return done(parseEslintJson(result.stdout, root), result.stdout.length);
    }
    if (tool === "biome") {
      const result = await runNode(
        root,
        bin,
        [
          "lint",
          "--reporter=github",
          "--no-errors-on-unmatched",
          "--files-ignore-unknown=true",
          ...targets,
        ],
        timeoutMs,
      );
      if (result.error) return done([], 0, result.error);
      const diagnostics = parseBiomeGithub(result.stdout, root);
      const configProblem = diagnostics.length === 0 && result.status !== 0;
      return done(
        diagnostics,
        result.stdout.length + result.stderr.length,
        configProblem
          ? (result.stderr || result.stdout).trim().split("\n").slice(0, 3).join(" ")
          : undefined,
      );
    }
    if (tool === "oxlint") {
      const result = await runNode(root, bin, ["--format=json", ...targets], timeoutMs);
      if (result.error) return done([], 0, result.error);
      const raw = result.stdout.length + result.stderr.length;
      try {
        // Exit 1 also means "lint errors found" or "every target is ignored": only output decides.
        return done(parseOxlintJson(result.stdout, root), raw);
      } catch {
        const text = (result.stderr || result.stdout).trim().split("\n").slice(0, 3).join(" ");
        return done([], raw, `oxlint failed: ${text || `exit code ${String(result.status)}`}`);
      }
    }
    const diagnostics: Diagnostic[] = [];
    let raw = 0;
    const projects = tsconfigProjects(root);
    const results = await mapLimit(projects, TSC_CONCURRENCY, (project) =>
      runNode(
        root,
        bin,
        ["--noEmit", "--pretty", "false", "-p", asPathArgs([project])[0] ?? project],
        timeoutMs,
      ),
    );
    for (const result of results) {
      if (result.error) return done(diagnostics, raw, result.error);
      raw += result.stdout.length;
      const parsed = parseTscOutput(result.stdout, root);
      if (parsed.length === 0 && result.status !== 0 && result.status !== null) {
        return done(
          diagnostics,
          raw,
          (result.stdout || result.stderr).trim().split("\n").slice(0, 3).join(" "),
        );
      }
      diagnostics.push(...parsed);
    }
    // A file compiled by several projects reports the same error once per project.
    const unique = new Map(
      diagnostics.map((d) => [`${d.file}:${d.line}:${d.column}:${d.code}:${d.message}`, d]),
    );
    return done([...unique.values()], raw);
  } catch (error) {
    return done([], 0, error instanceof Error ? error.message : String(error));
  }
}
