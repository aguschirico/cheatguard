import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TempRepo {
  root: string;
  write(path: string, content: string | Buffer): void;
  remove(path: string): void;
  git(...args: string[]): string;
  commit(message?: string): void;
}

export function createTempRepo(files: Record<string, string> = {}): TempRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cg-repo-")));
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "core.autocrlf", "false");
  const repo: TempRepo = {
    root,
    write(path, content) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    remove(path) {
      rmSync(join(root, path), { force: true, recursive: true });
    },
    git,
    commit(message = "commit") {
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", message);
    },
  };
  for (const [path, content] of Object.entries(files)) repo.write(path, content);
  if (Object.keys(files).length > 0) repo.commit("initial");
  return repo;
}

export function tempNonRepoDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "cg-norepo-")));
}
