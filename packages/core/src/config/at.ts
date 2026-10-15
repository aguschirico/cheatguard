import { readTextAt } from "../changes.js";
import type { CheatguardConfig } from "../types.js";
import { CONFIG_FILE, configFromText } from "./index.js";

/**
 * The config as it was in a git tree (the baseline of the change being checked).
 * Reading it from the base means a change can never relax the rules it is judged by.
 */
export function loadConfigAt(root: string, tree: string): CheatguardConfig {
  return configFromText(readTextAt(root, tree, CONFIG_FILE).text);
}
