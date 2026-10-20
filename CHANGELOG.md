# Changelog

Every user-visible change is recorded here, in the pull request or commit that makes it, under **Unreleased**. A release renames that section to the version and its date. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [semantic versioning](https://semver.org/).

Categories: **Added** (new rules, checks, commands, integrations), **Changed** (behavior or output that works differently), **Fixed** (bugs: wrong findings, missed findings, crashes), **Removed**, **Security**, and **Benchmarks** (corpus, tasks and published numbers, including when they get worse).

## Unreleased

### Changed

- Linters run in parallel, and so do up to four tsc projects, so the end-of-task check takes about as long as the slowest tool instead of the sum.
- `config-tampering` no longer warns about a test or lint script that only gains more runs, on other files, of `node --check` or `tsc --noEmit` written exactly as it already runs them, with no added `yarn`/`npx` prefix (`&& node --check another.mjs`, `&& tsc --noEmit -p b`), or drops a package-manager prefix (`yarn tsc` → `tsc`). Every other added command is still a warning: test runners, interpreters and shells run their argument, and ESLint, Prettier and oxlint load executable configuration found next to the files they check.

### Fixed

- tsc in monorepos: a root `tsconfig.json` that compiles only some files (TanStack/form includes just its scripts) no longer hides type errors in workspace packages. Packages that no root project compiles are checked with their own `tsconfig.json`, and a root config that has both files and `references` checks the referenced projects too (`tsc -p` does not).
- Comments at the end of a line of code are now read: `return 'N/A' // TODO`, `run(); // eslint-disable-line` and `x; /* biome-ignore … */` were missed by `stub-left` and `type-suppression`. Text inside JSX that looks like a comment is still ignored, and a TODO quoted as `inline code` in a comment is a mention, not a TODO.
- `test-weakened` finds the code under test through tsconfig `paths` too (tests that import their package by its own name), so an expected value updated together with that code is a warning instead of a block.
- `Function` as the test of a conditional type (`T extends Function ? never : T`) is no longer reported as a type escape.

### Security

- `config-tampering` judges a gate script split across lines like one joined with `;` (the shell runs each line as its own command): `"vitest run\nexit 0"` or `"vitest run\ntrue"` in a `test` script were not blocked.

### Benchmarks

- Benchmark A: 154 agent pull requests (Cursor, Jules and Codex added) and 122 human ones, labeled v3. Precision on agent pull requests is lower on the larger sample (72%, from 87%); every wrong finding there comes from `test-weakened`.
- Benchmark C covers 10 repositories (4 more: unstorage, consola, and two large monorepos, TanStack/form and better-auth; better-auth is the first with Biome).
- The license list of quoted repositories keeps the license a repository's code was quoted under when the repository is later removed or relicensed.

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
