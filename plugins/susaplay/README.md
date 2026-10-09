# SusaPlay plugin

Lets an AI coding assistant work with [SusaPlay](https://susaplay.com) on a Unity WebGL game:
integrate the SusaPlay SDK, check the project's setup, inspect and publish builds, upload and
publish Addressables, and read your games and analytics.

## Install in Claude Code

```text
/plugin install susaplay --marketplace Susa-Games/susaplay-ai
```

On Claude Code older than 2.1.275:

```text
/plugin marketplace add Susa-Games/susaplay-ai
/plugin install susaplay@susaplay
```

Requires Node.js 20 or later.

## Install in Cursor

The plugin is waiting for review in the Cursor Marketplace. Until it is listed, install it
locally:

```bash
git clone https://github.com/Susa-Games/susaplay-ai.git
mkdir -p ~/.cursor/plugins/local
ln -s "$PWD/susaplay-ai/plugins/susaplay" ~/.cursor/plugins/local/susaplay
```

Then run **Developer: Reload Window** and check **Customize**: the four skills and the two MCP
servers should appear. On a Teams or Enterprise plan, an admin must turn on **Allow Local Plugin
Imports** first. `git pull` in `susaplay-ai` updates it.

On Windows, copy the `plugins/susaplay` folder to `%USERPROFILE%\.cursor\plugins\local\susaplay`
instead of linking it.

## The API key

In Claude Code, the plugin asks for a SusaPlay API key when you install it and keeps it in your
system's credential store, not in a settings file. Change it later with `/plugin configure susaplay`.

In Cursor, the key is the plugin variable `SUSAPLAY_API_KEY`. On a Teams or Enterprise plan, an
admin sets it in the Cursor dashboard under **Plugins → Configure**.

- Create the key in the [Developer Portal](https://dev.susaplay.com) under **API Keys**. The
  **AI assistant** preset can read, check, upload builds and stage Addressables; **AI assistant
  with live publishing** can also publish and roll back Addressables.
- **Never paste a key into a chat.** If you did, revoke it in the portal and create a new one.
- Without a key, the skills, the docs server and the local checks still work; the tools that need
  the API say where to set it.

## What it adds

**Skills**, loaded when the task matches:

| Skill | For |
| --- | --- |
| `susaplay-sdk` | Installing the SDK and using its modules; testing in the Editor Simulator |
| `susaplay-publish` | Building and publishing WebGL builds, review, preview links, retention |
| `susaplay-addressables` | Addressables settings, upload, plan, publish, rollback, the compatibility check |
| `susaplay-analytics` | Logging events and reading player activity |

**MCP servers:**

- `susaplay` — tools that read your games, check projects and builds, and publish. Tools that
  change something players see (`publish_addressables`, `rollback_addressables`) ask for your
  confirmation first. The full list is in the
  [server's README](../../packages/mcp-server/README.md#tools).
- `susaplay-docs` — searches the SusaPlay documentation at `docs.susaplay.com`.

## Support

Issues: [github.com/Susa-Games/susaplay-ai/issues](https://github.com/Susa-Games/susaplay-ai/issues).
Security reports: see [SECURITY.md](../../SECURITY.md).
