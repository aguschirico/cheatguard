import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Session state lives outside repositories; tests point it at a throwaway directory. */
export const STATE_HOME = mkdtempSync(join(tmpdir(), "cg-state-"));
process.env.CHEATGUARD_STATE_HOME = STATE_HOME;

export { createTempRepo, tempNonRepoDir } from "../../core/test/helpers/repo.js";

export const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function cli(
  args: string[],
  options: { cwd: string; input?: string; env?: NodeJS.ProcessEnv },
): CliResult {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: options.cwd,
    input: options.input ?? "",
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...options.env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
