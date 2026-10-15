# Changelog

## 0.1.1

- Windows: session state and hook file paths are resolved to one canonical path, so 8.3 short names (`RUNNER~1`) and `C:/...` vs `C:\...` spellings no longer split a session or make an edited file look outside the repository.
- The Claude Code plugin pins `cheatguard@0.1.1`.
- Package metadata: repository, homepage and issue tracker.

## 0.1.0

First release: eight diff-aware rules, linter orchestration (ESLint, Biome, tsc) that reports only what a change introduced, the `cheatguard` CLI, Claude Code hooks and plugin.
