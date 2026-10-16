# cheatguard

Catch the shortcuts AI coding agents take: deleted assertions, skipped tests, silenced type errors, relaxed configs, placeholder code and imports of packages that do not exist. cheatguard reads the diff, runs locally in milliseconds, and shows the agent only the lint and type errors its change introduced.

```bash
npm i -D cheatguard
npx cheatguard init claude-code   # SessionStart, PostToolUse and Stop hooks in .claude/settings.json
```

```bash
npx cheatguard check                        # working tree vs HEAD (+ new eslint/biome/oxlint/tsc errors)
npx cheatguard check --base origin/main     # in CI
npx cheatguard check --staged               # in a pre-commit hook
npx cheatguard lint                         # only the diagnostics you introduced
npx cheatguard accept                       # (a person, in a terminal) drop issues a released agent session left open
```

Exit codes: `0` clean · `1` blocking issues · `3` tool error or a linter that could not run.

Rules: `test-weakened`, `type-suppression`, `config-tampering`, `stub-left`, `phantom-import` (blocking); `swallowed-error`, `duplicate-export`, `scope-creep` (warnings). Configure severities, scope and linters in `cheatguard.config.json`; the configuration is read from the base of the change, so a change cannot relax its own check.

Documentation, rules, benchmarks and limitations: see the project repository.

Apache-2.0.
