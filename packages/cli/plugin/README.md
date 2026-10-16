# cheatguard — Claude Code plugin

cheatguard is a deterministic, diff-aware linter for code written by coding agents. This plugin installs its hooks without touching your repository's settings:

- **SessionStart** records what the working tree looked like, so pre-existing changes are never blamed on the agent.
- **PostToolUse** (Edit/Write) checks the file that was just edited and pushes back immediately.
- **Stop** checks the whole change (plus new eslint/biome/oxlint/tsc errors) before the agent may finish.

It blocks weakened tests, type suppressions, config tampering, stubs and phantom imports. Full rule list, configuration and benchmarks: https://github.com/aguschirico/cheatguard

## Install

```bash
claude plugin marketplace add aguschirico/cheatguard
claude plugin install cheatguard@cheatguard
```

Or try it for one session from a project that has cheatguard installed:

```bash
claude --plugin-dir ./node_modules/cheatguard/plugin
```

Prefer a pinned dev dependency? Run `npx cheatguard init claude-code` instead, which writes the same hooks to `.claude/settings.json` using your local install.

## What it runs, reads and writes

- Every hook runs `npx -y cheatguard@0.1.2 hook claude-code`, pinned to an exact version. The first run downloads the `cheatguard` package and its dependencies from the npm registry; nothing else is fetched.
- cheatguard makes no network requests and sends no data anywhere. There is no telemetry.
- It reads the files in your repository and runs `git` to compare the working tree with the state at the start of the session. That writes ordinary git objects to the repository's object store; it never commits, stages or changes your files.
- When the project has them, it runs your own ESLint, Biome, oxlint and `tsc` from the project's dependencies.
- It keeps its session state and an audit log of its decisions outside the repository: `$XDG_STATE_HOME/cheatguard` (default `~/.local/state/cheatguard`) on macOS and Linux, `%LOCALAPPDATA%\cheatguard` on Windows. Set `CHEATGUARD_STATE_HOME` to move it.

## License

Apache-2.0
