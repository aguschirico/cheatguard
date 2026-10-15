# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue.

Include the cheatguard version, how to reproduce the problem, and what an attacker gains. You should get an answer within a week.

## Scope

cheatguard is a guardrail against shortcuts taken by coding agents, not a sandbox (see "Limits" in the README). In scope:

- A change that cheatguard should block but that passes `cheatguard check` or the Claude Code Stop hook without a warning, when the bypass is a plain edit to files in the repository.
- cheatguard executing code, writing outside its state directory, the system temp directory and the repository's `.git/objects`, or modifying your index, branch or working tree.
- Leaks of file contents or secrets into the audit log, error log or hook output beyond what the check reports.

Out of scope: an agent with full write access to your machine editing files outside the repository (for example user-level Claude Code settings), or faking an interactive terminal to run `cheatguard accept`. These are documented limits.
