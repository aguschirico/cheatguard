# Changelog

Every user-visible change is recorded here, in the pull request or commit that makes it, under **Unreleased**. A release renames that section to the version and its date. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [semantic versioning](https://semver.org/).

Categories: **Added** (new rules, checks, commands, integrations), **Changed** (behavior or output that works differently), **Fixed** (bugs: wrong findings, missed findings, crashes), **Removed**, **Security**, and **Benchmarks** (corpus, tasks and published numbers, including when they get worse).

## Unreleased

### Changed

- Linters run in parallel, and so do up to four tsc projects, so the end-of-task check takes about as long as the slowest tool instead of the sum.

### Fixed

- tsc in monorepos: a root `tsconfig.json` that compiles only some files (TanStack/form includes just its scripts) no longer hides type errors in workspace packages. Packages that no root project compiles are checked with their own `tsconfig.json`, and a root config that has both files and `references` checks the referenced projects too (`tsc -p` does not).

## 0.1.2 — 2026-10-16

### Added

- oxlint support: cheatguard runs oxlint (when it has a `.oxlintrc.json` or `oxlint.config.ts`, or a `package.json` script runs it) and shows only the problems the change introduced, on every edit and at the end of the task. `config-tampering` reports oxlint configs relaxed: rules or categories weakened or turned off, plugins removed or default plugins dropped, paths ignored, overrides narrowed, presets removed.

### Changed

- `oxlint-disable` comments are reported as `oxlint-disable` directives instead of `eslint-disable`.
- The Claude Code plugin installs from the repository's own marketplace (`claude plugin marketplace add aguschirico/cheatguard`), its README says what it runs, reads and writes, and it pins `cheatguard@0.1.2`.

### Fixed

- `cheatguard accept` no longer crashes with `EAGAIN` when the terminal leaves stdin non-blocking: it reads the code from `/dev/tty` and waits for it. Its refusal message now says that Claude Code's `!` prefix is not an interactive terminal.

## 0.1.1 — 2026-10-15

### Added

- Package metadata: repository, homepage and issue tracker.

### Changed

- The Claude Code plugin pins `cheatguard@0.1.1`.

### Fixed

- Windows: session state and hook file paths are resolved to one canonical path, so 8.3 short names (`RUNNER~1`) and `C:/...` vs `C:\...` spellings no longer split a session or make an edited file look outside the repository.

## 0.1.0 — 2026-10-15

### Added

- First release: eight diff-aware rules, linter orchestration (ESLint, Biome, tsc) that reports only what a change introduced, the `cheatguard` CLI, Claude Code hooks and plugin.
