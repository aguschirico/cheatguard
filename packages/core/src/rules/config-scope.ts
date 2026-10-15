import picomatch from "picomatch";

/** Directory of a repo-relative path ("" for the root). */
export function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/^<rootDir>\//, "").replace(/^\.\//, "");
}

/**
 * Glob patterns of a config file match paths relative to the config's directory. `directories`
 * lets a bare name ("src") cover everything below it; tools differ on this, so callers use it only
 * where being generous fails closed (the old patterns).
 */
function matcher(patterns: readonly string[], directories: boolean): (path: string) => boolean {
  const positive = patterns.filter((p) => !p.startsWith("!")).map(normalizePattern);
  const negative = patterns
    .filter((p) => p.startsWith("!"))
    .map((p) => normalizePattern(p.slice(1)));
  if (positive.length === 0) return () => false;
  const include = picomatch(positive, { dot: true });
  const exclude = negative.length > 0 ? picomatch(negative, { dot: true }) : () => false;
  // A bare directory ("src") covers everything below it.
  const dirs = directories
    ? positive.filter((p) => !/[*?{}[\]]/.test(p) && !/\.[\w]+$/.test(p))
    : [];
  return (path) =>
    !exclude(path) && (include(path) || dirs.some((d) => path === d || path.startsWith(`${d}/`)));
}

/**
 * Project files that matched the old patterns but not the new ones. `configPath` anchors relative
 * patterns at the config file's directory.
 */
export function filesLost(
  files: readonly string[],
  configPath: string,
  before: readonly string[],
  after: readonly string[],
): string[] {
  const base = dirOf(configPath);
  const was = matcher(before, true);
  const now = matcher(after, false);
  const lost: string[] = [];
  for (const file of files) {
    if (base !== "" && !file.startsWith(`${base}/`)) continue;
    const rel = base === "" ? file : file.slice(base.length + 1);
    if (was(rel) && !now(rel)) lost.push(file);
  }
  return lost;
}

/** Files under the config's directory that the patterns do not match. */
export function filesNotMatched(
  files: readonly string[],
  configPath: string,
  patterns: readonly string[],
): string[] {
  const base = dirOf(configPath);
  const match = matcher(patterns, false);
  return files.filter((file) => {
    if (base !== "" && !file.startsWith(`${base}/`)) return false;
    return !match(base === "" ? file : file.slice(base.length + 1));
  });
}

export function listSample(paths: readonly string[], max = 3): string {
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown;
}
