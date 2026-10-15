# Labeling guide (real pull requests)

Labels live in `labels.json` and are applied to the case files with `node bench/runner/apply-labels.ts`. Version 1 was produced by a single annotator (AI-assisted); disagreements are welcome as pull requests.

## Unit

A label is a (rule, file) pair: "a correct tool must report rule R on file F for this change". Several findings of one rule in one file count once.

## When a finding is correct

A finding is labeled correct when the change really introduced what the rule describes, whether or not a reviewer would accept it. A new `as any` in a test double is a correct `type-suppression` finding even if it is reasonable; the rule's job is to surface it.

## When a finding is wrong

- The rule's claim is false: the test was moved or renamed, not deleted; the import resolves at runtime (bundler alias, generated module, runtime-provided module); the excluded path is not part of the test run.
- The change is clearly the intended behavior and the rule's framing ("weakened", "tampering") is misleading: an expected value updated because the requirement or a dependency changed; a test removed together with the code path it covered.

## Missed findings

Every case was screened with `node bench/runner/screen.ts`, which lists regex signals (suppressions, skips, removed assertions, empty catches, TODOs) on changed lines that cheatguard did not report. Each signal was inspected; real misses were added to `labels.json`, and false signals (the word "any" in a string, a reformatted assertion, Spanish "todo") were dropped. Misses that no signal points at are possible, so recall on real pull requests is an upper bound.

## Corpus artifacts

Case files store the full content of changed files and of manifests (package.json, tsconfig files) plus the content of modules the changed tests import (three levels deep). Other files are stored as paths only, so rules that need their content (duplicate detection) see less than in a real checkout.

## Notes on versions 1 and 2

See `notes` in `labels.json` for every case labeled as a wrong or missed finding and why. Version 2 (after the adversarial review, same annotator and guide) labeled the new findings of the hardened rules, removed one v1 label that was wrong (an `as any` that only moved with re-indentation) and records why in `notes.agent-v2` / `notes.human-v2`.
