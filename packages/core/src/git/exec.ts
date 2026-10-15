import { execFileSync } from "node:child_process";

export class GitError extends Error {
  override readonly name = "GitError";
}

export class NotAGitRepoError extends Error {
  override readonly name = "NotAGitRepoError";
  constructor(readonly cwd: string) {
    super(`Not a git repository: ${cwd}. cheatguard needs git to compute what changed.`);
  }
}

export interface GitRunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
}

const MAX_BUFFER = 512 * 1024 * 1024;

export function gitBuffer(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Buffer {
  try {
    return execFileSync("git", args, {
      cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      input: options.input,
      maxBuffer: MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new GitError(`git ${args.join(" ")} failed: ${stderr.trim() || message}`);
  }
}

export function git(cwd: string, args: readonly string[], options: GitRunOptions = {}): string {
  return gitBuffer(cwd, args, options).toString("utf8");
}
