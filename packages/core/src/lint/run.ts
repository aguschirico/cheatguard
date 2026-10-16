import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
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

function runNode(
  root: string,
  script: string,
  args: readonly string[],
  timeoutMs: number,
): { stdout: string; stderr: string; status: number | null; error?: string } {
  // No shell on any platform: arguments reach node verbatim.
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    shell: false,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const out: { stdout: string; stderr: string; status: number | null; error?: string } = {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
  if (result.error) out.error = result.error.message;
  return out;
}

/** tsconfig projects to check: the root one, or its references when it is a solution-style config. */
export function tsconfigProjects(root: string): string[] {
  const path = join(root, "tsconfig.json");
  // Monorepos without a root tsconfig: check every workspace package that has one.
  if (!existsSync(path)) return workspaceTsconfigs(root);
  const config: unknown = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8")).config;
  const parsed = isRecord(config) ? config : {};
  const refs = asArray(parsed.references);
  const solution =
    refs.length > 0 &&
    Array.isArray(parsed.files) &&
    parsed.files.length === 0 &&
    parsed.include === undefined;
  if (!solution) return ["tsconfig.json"];
  return refs
    .map((r) => (isRecord(r) && typeof r.path === "string" ? r.path : ""))
    .filter(Boolean)
    .map((p: string) => (p.endsWith(".json") ? p : posix.join(p, "tsconfig.json")));
}

export function runTool(
  root: string,
  tool: LintToolName,
  files: readonly string[] | "all",
  timeoutMs = DEFAULT_TIMEOUT_MS,
): ToolOutput {
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
      let result = runNode(
        root,
        bin,
        ["--format", "json", "--no-warn-ignored", ...targets],
        timeoutMs,
      );
      if (result.status === 2 && /no-warn-ignored/.test(result.stderr)) {
        result = runNode(root, bin, ["--format", "json", ...targets], timeoutMs);
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
      const result = runNode(
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
      const result = runNode(root, bin, ["--format=json", ...targets], timeoutMs);
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
    for (const project of tsconfigProjects(root)) {
      const result = runNode(
        root,
        bin,
        ["--noEmit", "--pretty", "false", "-p", asPathArgs([project])[0] ?? project],
        timeoutMs,
      );
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
    return done(diagnostics, raw);
  } catch (error) {
    return done([], 0, error instanceof Error ? error.message : String(error));
  }
}
