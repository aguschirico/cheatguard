# cheatguard — Claude Code plugin

Installs cheatguard's hooks without touching your repository's settings:

- **SessionStart** records what the working tree looked like, so pre-existing changes are never blamed on the agent.
- **PostToolUse** (Edit/Write) checks the file that was just edited and pushes back immediately.
- **Stop** checks the whole change (plus new eslint/biome/tsc errors) before the agent may finish.

Try it locally:

```bash
claude --plugin-dir ./node_modules/cheatguard/plugin
```

The hooks run `npx -y cheatguard@<version>`, so the first run downloads the CLI. Prefer a pinned dev
dependency? Run `npx cheatguard init claude-code` instead, which writes the same hooks to
`.claude/settings.json` using your local install.
