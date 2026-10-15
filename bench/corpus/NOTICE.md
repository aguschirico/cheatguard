# Third-party code in this corpus

The files under `agent/` and `human/` contain excerpts (file contents before and after a pull request) from public repositories licensed under permissive licenses (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense). Each case file records its source pull request URL, repository, author and license in its `source` field.

The license text of every quoted repository (with its copyright notice, and the NOTICE file of Apache-2.0 projects) is in [`licenses/`](licenses/README.md); regenerate it with `node bench/runner/fetch-licenses.ts`.

These excerpts are included solely to evaluate a static analysis tool. They remain under their original licenses and copyright of their respective authors. If you are an author and want a case removed, open an issue and it will be removed.
