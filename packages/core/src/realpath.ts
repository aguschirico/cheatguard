import { realpathSync } from "node:fs";

/**
 * Canonical absolute path (throws like realpathSync when the path does not exist). On Windows one
 * directory has several spellings (C:/Users/..., C:\Users\..., 8.3 short names such as RUNNER~1);
 * only the native call maps them all to the same string.
 */
export function canonicalPath(path: string): string {
  return process.platform === "win32" ? realpathSync.native(path) : realpathSync(path);
}
