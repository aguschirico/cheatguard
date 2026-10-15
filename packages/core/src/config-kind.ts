export type ConfigKind =
  | "tsconfig"
  | "package"
  | "eslint"
  | "eslint-ignore"
  | "biome"
  | "test-runner"
  | "ci"
  | "agent-settings"
  | "workspace"
  | "cheatguard";

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Single source of truth for which files configure a quality gate. */
export function configKindOf(path: string): ConfigKind | null {
  const base = basename(path);
  if (base === "cheatguard.config.json") return "cheatguard";
  if (/^[tj]sconfig([.-][\w-]+)*\.json$/.test(base)) return "tsconfig";
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(path)) return "agent-settings";
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || /^\.gitlab-ci\.ya?ml$/.test(path))
    return "ci";
  if (base === ".eslintignore") return "eslint-ignore";
  if (path === "pnpm-workspace.yaml") return "workspace";
  if (base === "package.json") return "package";
  if (
    /^\.eslintrc(\.(json|js|cjs))?$/.test(base) ||
    /^eslint\.config(\.[\w-]+)*\.[cm]?[jt]s$/.test(base)
  )
    return "eslint";
  if (/^biome\.jsonc?$/.test(base)) return "biome";
  if (/^(vitest|vite|jest)(\.[\w-]+)*\.config(\.[\w-]+)*\.([cm]?[jt]s|json)$/.test(base))
    return "test-runner";
  if (/^vitest\.(workspace|projects)(\.[\w-]+)*\.[cm]?[jt]s$/.test(base)) return "test-runner";
  if (/^(playwright|cypress|ava)(\.[\w-]+)*\.config\.[cm]?[jt]s$/.test(base)) return "test-runner";
  if (/^karma\.conf\.[cm]?[jt]s$/.test(base) || /^\.mocharc(\.(json|jsonc|js|cjs))?$/.test(base))
    return "test-runner";
  return null;
}
