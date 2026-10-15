# Contributing

Thanks for helping. cheatguard is small on purpose: deterministic rules, no network, no AI in the loop.

## Setup

```bash
pnpm install
pnpm build
pnpm test        # core + CLI suites
pnpm lint        # Biome
pnpm typecheck
```

Node 20 or newer. The code is TypeScript with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; `any` is not allowed (use `unknown` and narrow).

## Layout

- `packages/core` — git snapshots, the TypeScript adapter, rules, linter orchestration, reports.
- `packages/cli` — the `cheatguard` command, Claude Code hooks and plugin.
- `bench` — the three benchmarks (see `bench/README.md`).
- `site`, `demo` — the landing page and the terminal recordings.

## Adding or changing a rule

1. Write tests first in `packages/core/test/rules/`: at least ten cases that must be reported and ten that must not, including "hard negatives" (legitimate changes that look like the shortcut).
2. Rules are pure functions over a `RuleContext` (changed files with parsed facts, plus read-only project access). Report only what the change introduced.
3. Every finding needs a `fix` that tells an agent what to do instead.
4. Run the corpus (`node bench/runner/corpus.ts --errors`) and look at every new wrong flag on real pull requests before opening a pull request.

## Reporting a false positive or a missed shortcut

Open an issue with the diff (or a minimal reproduction) and the cheatguard output. Real cases are the most valuable contribution: they become regression tests and corpus cases.

## Security

cheatguard is a guardrail, not a sandbox, but bypasses that a shortcut-taking agent could plausibly hit are bugs. Please report them as issues (or privately if you prefer).

## Releases

Version numbers follow semver. The CLI package and the Claude Code plugin manifest share a version (a test enforces it).
