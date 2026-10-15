# Roadmap

Phases 2 to 5 can be reordered by what users ask for.

## Phase 1 — MVP and launch (this release)

The eight diff-aware rules, linter orchestration (ESLint, Biome, tsc), the CLI, Claude Code hooks and plugin, three benchmarks, the landing page and demos.

## Phase 2 — Depth and precision

- **First, the two gaps benchmark B measured** (cheatguard never intervened in those runs, and a `CLAUDE.md` with rules did better): an opt-in Stop check that runs the project's test command (agents stopped with a failing test they had not run: `strict-mode`, 0/5 with cheatguard against 5/5 with rules), and detection of an existing helper re-implemented inline (`invoice-format` with Haiku, 0/3 against 3/3). Re-run benchmark B with both before claiming an effect.
- Type-aware mode (TypeScript program): inferred `any`, unsafe casts, new non-null assertions, widened return types.
- New rules: deeper over-mocking analysis (beyond mocking the module under test), more weakened-matcher pairs (`toEqual` → `toMatchObject`), mass snapshot updates, inflated timeouts, removed validation, hard-coded secrets, commented-out code, fake success returns, coverage drops, duplicated logic written inline. (Weakened matchers, mocks of the subject, raised retries, conditional and unreachable assertions shipped in the hardening pass.)
- Suppression swaps (a new `any` while another is removed) detected by location instead of counts.
- Inline suppression with a mandatory, audited justification (`// cheatguard-allow test-weakened: <reason>`).
- Structural YAML analysis for `.eslintrc.yml` and CI workflows (today CI checks are line-based plus a YAML validity check), effective ESLint config comparison.
- Autofix suggestions, incremental cache, a public API for third-party rules.

## Phase 3 — Every agent

- Adapters for Codex CLI, Cursor, Gemini CLI, the GitHub Copilot coding agent and Aider.
- An MCP server: `cheatguard_check`, plus context tools ("does a function for X already exist?", "who calls this?", "which tests cover this file?").
- An official GitHub Action; pre-commit, husky and lefthook integrations; a VS Code extension.

## Phase 4 — More languages

Tree-sitter adapters for Python (pytest, mypy), Go and Rust, each with its own corpus and agent tasks.

## Phase 5 — Community

- A public leaderboard of how often agents and models take shortcuts, re-run when new models ship, on harder and longer tasks than phase 1.
- A registry of community rule packs, a documentation site, and benchmark tasks accepted by pull request.
