import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CheatguardConfig,
  CONFIG_FILE,
  ConfigError,
  configFromText,
  loadConfigAt,
  readTextAt,
  repoRoot,
  resolveTree,
} from "@cheatguard/core";

export interface RepoContext {
  root: string;
  /** Tree of the base being compared against. */
  baseTree: string;
  /** Config as committed in the base: a change can never relax its own check. */
  config: CheatguardConfig;
}

/**
 * A note for people running the CLI when the working-tree config differs from the one in use
 * (checks read it from the base, so an uncommitted config has no effect yet), or null.
 */
export function configNote(root: string, baseTree: string): string | null {
  const path = join(root, CONFIG_FILE);
  let regularFile = false;
  try {
    regularFile = lstatSync(path).isFile();
  } catch {
    return null; // no working-tree config
  }
  // A symlink could point anywhere; never read or echo its target.
  if (!regularFile) return `note: ${CONFIG_FILE} is not a regular file and is ignored.`;
  const local = readFileSync(path, "utf8");
  if (local === readTextAt(root, baseTree, CONFIG_FILE).text) return null;
  try {
    JSON.parse(local);
  } catch {
    return `note: your working-tree ${CONFIG_FILE} is not valid JSON and would be rejected once committed.`;
  }
  try {
    configFromText(local);
  } catch (error) {
    const reason = error instanceof ConfigError ? error.message : String(error);
    return `note: your working-tree ${CONFIG_FILE} is invalid and would be rejected once committed: ${reason}`;
  }
  return `note: ${CONFIG_FILE} has uncommitted changes; checks use the committed version (commit it to apply it). A change can never relax the rules it is checked by.`;
}

export function openRepo(cwd: string, base: string): RepoContext {
  const root = repoRoot(cwd);
  const baseTree = resolveTree(root, base);
  const note = configNote(root, baseTree);
  if (note) process.stderr.write(`${note}\n`);
  return { root, baseTree, config: loadConfigAt(root, baseTree) };
}

export function useColor(stream: NodeJS.WriteStream): boolean {
  return stream.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}
