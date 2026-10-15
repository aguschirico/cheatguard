import { isAbsolute, relative } from "node:path";
import { canonicalPath } from "../realpath.js";

function real(path: string): string {
  try {
    return canonicalPath(path);
  } catch {
    return path;
  }
}

/** Normalizes a tool-reported path to a POSIX path relative to the repository root. */
export function toRepoPath(root: string, file: string): string {
  const slashed = file.replace(/\\/g, "/");
  if (!(isAbsolute(file) || /^[A-Za-z]:\//.test(slashed))) return slashed.replace(/^\.\//, "");
  let rel = relative(root, file);
  // Roots and tool output may disagree on symlinks (/var vs /private/var on macOS).
  if (rel.startsWith("..")) rel = relative(real(root), real(file));
  return rel.replace(/\\/g, "/");
}
