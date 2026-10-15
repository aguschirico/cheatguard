# Configuration

cheatguard works without configuration. To change its behavior, add `cheatguard.config.json` at the repository root. A JSON Schema is printed by `npx cheatguard schema` (and shipped as `node_modules/cheatguard/cheatguard.schema.json`):

```json
{ "$schema": "./node_modules/cheatguard/cheatguard.schema.json" }
```

## Where the configuration is read from

The configuration always comes from the **base** of the change being checked:

- `cheatguard check --base <ref>` reads it from `<ref>` (default `HEAD`).
- Inside Claude Code it is read from the snapshot taken when the session started.

A change therefore cannot relax the rules it is judged by. Editing the file is reported by `config-tampering`; commit the change (or start a new session) for it to take effect. The CLI prints a note on stderr when your working-tree config differs from the one in use, and tells you if it is invalid before you commit it. A `cheatguard.config.json` that is a symlink is never read.

## Keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `rules` | object | `{}` | Per-rule severity: `"block"`, `"warn"` or `"off"`. Rules: `test-weakened`, `type-suppression`, `config-tampering`, `stub-left`, `phantom-import`, `swallowed-error`, `duplicate-export`, `scope-creep`, `parse-error`. |
| `scope.allow` | string[] | `[]` | Globs of paths the task may touch. Enables `scope-creep`. |
| `tests.patterns` | string[] | `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/test/**`, `**/tests/**` | Which files are tests. |
| `ignore` | string[] | `node_modules`, `dist`, `build`, `coverage`, `*.min.js`, `*.generated.*`, `_generated/`, `__generated__/` | Added to the defaults. Config files are never ignored. |
| `lint.tools` | `"auto"` or `("eslint" \| "biome" \| "tsc")[]` | `"auto"` | Linters to run. `auto` uses every tool that has a config and a local install, and warns about a configured tool that is not installed. Listing tools makes them **required**: if one cannot run, `check` and `lint` exit 3 and the Stop hook blocks. tsc uses the root `tsconfig.json`, or, in a monorepo without one, the `tsconfig.json` of every workspace package. |
| `lint.onEdit` | tool[] | `["eslint", "biome"]` | Linters run after each edit (fast, on the edited file). |
| `lint.onStop` | tool[] | `["eslint", "biome", "tsc"]` | Linters run before the agent may finish. |
| `lint.maxDiagnostics` | number | `20` | How many new diagnostics to print (JSON output always has all of them). |
| `lint.blockOnStop` | boolean | `true` | Whether new lint/type **errors** block finishing (and make `check` exit 1). |
| `hooks.maxStopBlocks` | number | `3` | Consecutive blocked attempts to finish before cheatguard lets the agent stop and reports what is left. Those issues do not block the same session again (you are reminded at each later Stop), and new sessions keep checking them until you run `cheatguard accept`. |
| `hooks.warnAgentOnStop` | boolean | `true` | Show new warnings to the agent once when it tries to finish (a soft block it can answer by fixing them or saying why they are intended). With `false`, warnings at Stop go only to you. |
| `hooks.baselineWaitSeconds` | integer (0–240) | `60` | How long the Stop hook waits for the session's lint baseline if it is still being recorded. |

## Examples

Strict team setup:

```json
{
  "rules": { "swallowed-error": "block", "duplicate-export": "block" },
  "scope": { "allow": ["src/**", "test/**"] }
}
```

Legacy repository, adopted gradually:

```json
{
  "rules": { "stub-left": "warn" },
  "ignore": ["src/legacy/**"],
  "lint": { "blockOnStop": false }
}
```

## Linters and the session baseline

When a session starts, cheatguard records the diagnostics your linters already report (in the background, so the session starts at once). At Stop, only diagnostics that are not in that baseline count, including new type errors in files the agent did not touch. If the agent edits files while the baseline is being recorded, it is recorded again from the session's starting tree in a temporary checkout outside the repository. A linter that worked at the start but cannot run at Stop (uninstalled, crashing, broken config) blocks.

## Accepting issues a released session left open

After `hooks.maxStopBlocks` blocked attempts the agent may stop, and the open issues carry over to the next sessions. After reviewing them, run in a terminal:

```bash
npx cheatguard accept
```

It asks you to type a random code and refuses to run without an interactive terminal or inside a Claude Code tool call, so an agent cannot accept on your behalf. Every acceptance is written to the audit log.

## Where state is kept

Session baselines and counters live outside the repository, in `$XDG_STATE_HOME/cheatguard` (or `~/.local/state/cheatguard`; `%LOCALAPPDATA%\cheatguard` on Windows). Set `CHEATGUARD_STATE_HOME` to move it. Internal errors are logged to `errors.log`, every push-back and acceptance to `interventions.jsonl`, and a session released with open issues to `released.json`, all in the same directory. If the directory is not writable, the hooks still report what they found.
