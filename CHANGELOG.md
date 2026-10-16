# Changelog

## 0.1.2

- oxlint support: cheatguard runs oxlint (when it has a `.oxlintrc.json` or `oxlint.config.ts`, or a `package.json` script runs it) and shows only the problems the change introduced, on every edit and at the end of the task. `config-tampering` reports oxlint configs relaxed: rules or categories weakened or turned off, plugins removed or default plugins dropped, paths ignored, overrides narrowed, presets removed. `oxlint-disable` comments are now reported as `oxlint-disable` directives instead of `eslint-disable`.
- `cheatguard accept` no longer crashes with `EAGAIN` when the terminal leaves stdin non-blocking: it reads the code from `/dev/tty` and waits for it. Its refusal message now says that Claude Code's `!` prefix is not an interactive terminal.
- The Claude Code plugin installs from the repository's own marketplace (`claude plugin marketplace add aguschirico/cheatguard`), its README says what it runs, reads and writes, and it pins `cheatguard@0.1.2`.

## 0.1.1

- Windows: session state and hook file paths are resolved to one canonical path, so 8.3 short names (`RUNNER~1`) and `C:/...` vs `C:\...` spellings no longer split a session or make an edited file look outside the repository.
- The Claude Code plugin pins `cheatguard@0.1.1`.
- Package metadata: repository, homepage and issue tracker.

## 0.1.0

First release: eight diff-aware rules, linter orchestration (ESLint, Biome, tsc) that reports only what a change introduced, the `cheatguard` CLI, Claude Code hooks and plugin.
