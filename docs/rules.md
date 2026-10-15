# Rules

cheatguard compares the state before a change with the state after it. Every rule reports only what the change **introduced**: a suppression that already existed, a TODO that only moved, or a test that was renamed is not reported.

Each finding says what changed and what to do instead, because the reader is usually an agent that has to fix it.

Severity can be changed per rule in [`cheatguard.config.json`](configuration.md) (`"block"`, `"warn"` or `"off"`).

---

## `test-weakened` — blocks

Detects changes that make a test suite easier to pass without making the code better.

| Reported | Example |
|---|---|
| A test was deleted | `it("rejects expired tokens", …)` is gone |
| A test lost assertions that can run and check something | 3 `expect(...)` calls became 1; a `return;` before the assertions; assertions moved into a function that is never called or under `if (false)`; `expect(sum(2, 2)).toBe(4)` replaced by `expect(4).toBe(4)` |
| A test was skipped, focused, inverted or turned into a todo | `it.skip`, `it.only`, `xit`, `describe.skip`, `it.todo`, `it.fails` / `it.failing` |
| A test was made conditional or emptied | `it.skipIf(cond)`, `it.runIf(cond)`, `describe.runIf(false)` (only `skipIf(false)` / `runIf(true)` are no-ops), `it.each([])`, `it.for([])` |
| An expected value was edited | `expect(total(lines)).toBe(70)` became `.toBe(72)` |
| A matcher was weakened | `toBe(4)` → `toBeDefined()`, `toBeTruthy()`, `toBeTypeOf(…)`, `not.toBe(5)`, `toEqual(expect.anything())`, `toThrow()` without the expected error |
| A whole test file was deleted, or moved where the runner does not collect it | `test/auth.test.ts` removed, or renamed to `auth.test.ts.bak`, `auth.disabled.ts`, `fixtures/auth.ts` |
| Warning: assertions that now run only under a runtime condition | assertions newly wrapped in `if (…)`, a loop, a ternary or a `catch` |
| Warning: a new mock of the module under test | `vi.mock("./sum", …)` in a test that asserts on `sum` |

What it deliberately does not report:

- A test removed together with the code it tested (the imported symbol was removed from its module, or the module was deleted).
- A test moved to another test file in the same change, or renamed with the same (or more) assertions; also a whole test file deleted whose tests all reappear in other test files. A moved test that lost assertions is a warning.
- `toBe` → `toEqual` (and other matcher changes that do not accept more values).
- Reformatting, reordering and added assertions.
- An expected value changed when the code under test also changed (followed through relative imports and barrel files): that is reported as a **warning**, because the requirement may genuinely have changed.

Known limits: runtime conditions that are never true are only warnings, un-awaited `.resolves`/`.rejects` are not detected, and weakening pairs beyond the list above (`toEqual` → `toMatchObject`, `toContain`) pass. On real pull requests (benchmark A) this rule has produced no correct finding yet: every finding was a legitimate expectation update, which is why it explains itself and is easy to override per rule.

## `type-suppression` — blocks (mostly warns in test files)

New escapes from the type checker, the linter or coverage:

`any` in a type position, `as any`, `<any>x`, `as never` / `<never>x`, double casts through `unknown` in either syntax (`x as unknown as T`, `<T><unknown>x`, `<T>(x as unknown)`), the `Function` type, a body-less `declare module "x";` (every import from it becomes `any`), `// @ts-ignore`, `// @ts-expect-error`, `// @ts-nocheck`, `eslint-disable*`, `oxlint-disable*`, `biome-ignore*`, and `/* v8 ignore */`, `/* c8 ignore */`, `/* istanbul ignore */` comments.

The word "any" in strings or comments is never reported, and typed wildcard modules (`declare module "*.svg" { … }`) are fine. In test files these are warnings, because test doubles legitimately need casts, except `@ts-ignore` and `@ts-nocheck`, which still block (use `@ts-expect-error` to test invalid inputs).

A suppression on a line that already had one and was edited is not reported again; a new one is reported even when the same change removes unrelated ones elsewhere.

## `config-tampering` — blocks

Changes that relax a quality gate. The configuration is compared semantically, not textually.

| File | Reported |
|---|---|
| `tsconfig*.json`, `tsconfig-*.json`, and any JSON file reached through relative `extends` | Strict-family flags turned off, removed or explicitly set to false; files added to `exclude` or removed from `include`; an extended preset removed; `skipLibCheck` enabled (warning) |
| ESLint (`eslint.config.*`, `.eslintrc*`, `package.json#eslintConfig`, `.eslintignore`) | A rule weakened or turned off, in any config object or override; new ignore patterns or `.eslintignore` lines; `files` patterns narrowed so they no longer cover files they covered; extended presets removed |
| `biome.json(c)` | Linter or recommended rules disabled; a rule weakened or turned off (overrides included); files excluded or `includes` narrowed |
| Vitest, Vite (`test` section), Jest, Playwright, Cypress, Mocha, Karma, AVA | Coverage thresholds lowered or removed; `passWithNoTests` enabled; tests excluded (`exclude`, `testPathIgnorePatterns`, `testIgnore`, `ignore`…); include/testMatch/spec patterns changed so an existing test file no longer matches; a new config that leaves existing tests out; source files excluded from coverage. Warnings: new `alias`, `setupFiles`, `globalSetup`, `moduleNameMapper`, raised `retry`/`retries` |
| `package.json` scripts | `test`, `lint`, `typecheck`, `check`, `verify`, `ci` scripts removed, or edited so they can pass without doing the work: a tool they ran dropped, `\|\| true`, `; true`, `&`, a pipe or `exit` added, narrowing flags (`--exclude`, `-t`, `--testPathIgnorePatterns`, `--changed`…), `--passWithNoTests`; other edits to those scripts are warnings |
| Workspaces (`pnpm-workspace.yaml`, `package.json#workspaces`) | A workspace package removed (it would no longer be type-checked) |
| CI (`.github/workflows/*.yml`, `.gitlab-ci.yml`) | `continue-on-error` / `allow_failure`, a constant-false `if` or `when: never`, `set +e`, `\|\| true` on a check, a check step removed (line-based) |
| `.claude/settings.json`, `.claude/settings.local.json` | A hook that runs cheatguard removed or changed, the cheatguard plugin disabled, `disableAllHooks` turned on, the file made invalid JSON |
| Any of the above | Deleted, renamed (the tool would stop loading it), or no longer parseable |
| `cheatguard.config.json` | Any change at all |

A brand-new config file is checked too, because it can shadow an existing one (a nested `.eslintrc`, a `vitest.config.ts` next to `vite.config.ts`).

Known limits: YAML configs other than the workspace and CI checks above are not parsed, and values computed at runtime in JS configs (rules switched off through a variable) are not evaluated.

## `stub-left` — blocks

Placeholder code left instead of an implementation:

- A new `throw new Error("Not implemented")` (also "TODO", "TBD", "FIXME", "unimplemented", `new NotImplementedError()`).
- A function whose body had three or more statements now just returns a constant or is empty ("gutted").
- New comments saying the code is missing: "TODO: implement", "not implemented yet", "placeholder implementation", "stub for now". Other new TODO/FIXME comments are warnings.

## `phantom-import` — blocks

New imports that cannot work:

- A package that is not declared in the nearest `package.json` or the root one (workspace packages count; a package.json created in the same change does not).
- A package declared but not installed, when a `node_modules` exists.
- A relative or absolute path that resolves to no file (`.js` imports resolving to `.ts` files are understood).
- A `#subpath` import missing from `package.json` `"imports"`.

Not reported: Node built-ins, aliases from any `tsconfig*.json` whose target exists, specifiers that cannot be npm package names (`$lib/…`, `~/…`, `@/…`, used by bundler aliases), runtime-provided modules declared through their types (`vscode`), and type-only imports covered by an `@types` package.

## `swallowed-error` — warns

New `catch` blocks that are empty, contain only a comment, or only call `console.*`, and `.catch(() => {})`, `.catch(() => undefined)` or `.catch(() => null)` handlers. Rethrowing, wrapping, returning a fallback or reporting the error is fine.

## `duplicate-export` — warns · project-wide

A new exported function whose name is a near-copy of an existing export (`formatDate2`, `formatDateNew`, `format_date` next to `formatDate`), or whose body is at least 85% similar to one. Moving a function to another file is not reported.

Known limit: duplicated logic written inline (not as a new exported function) is not detected.

## `scope-creep` — warns · project-wide

Files changed, deleted or moved outside `scope.allow`. Only active when you configure a scope.

## `parse-error` — internal

A changed file that does not parse is reported as a warning and skipped by the AST rules. A source, test or config file over 1 MB is reported as **blocking**, because its changes cannot be verified.
