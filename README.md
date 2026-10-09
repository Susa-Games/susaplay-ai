# SusaPlay AI tools

Tools that let AI coding assistants work with [SusaPlay](https://susaplay.com): integrate the
SusaPlay SDK, check a Unity project's setup, inspect and publish WebGL builds, upload and publish
Addressables, and read your games and analytics.

## Claude Code

```text
/plugin install susaplay --marketplace Susa-Games/susaplay-ai
```

On Claude Code older than 2.1.275, add the marketplace first:

```text
/plugin marketplace add Susa-Games/susaplay-ai
/plugin install susaplay@susaplay
```

Claude Code asks for your SusaPlay API key when you install the plugin, and keeps it in your
system's credential store; change it later with `/plugin configure susaplay`. Create the key in the [Developer Portal](https://dev.susaplay.com) under
**API Keys**. Never paste it into a chat. See [the plugin's README](plugins/susaplay/README.md).

## Cursor

The plugin is waiting for review in the Cursor Marketplace. Until it is listed, install it locally
— see [the plugin's README](plugins/susaplay/README.md#install-in-cursor).

## Other tools

The MCP server is on npm as [`@susaplay/mcp`](https://www.npmjs.com/package/@susaplay/mcp)
([manual setup](packages/mcp-server/README.md)); the skills in `plugins/susaplay/skills` follow the
open `SKILL.md` format.

## Contents

| Path | What it is |
| --- | --- |
| `packages/mcp-server` | Source of the MCP server, published to npm as `@susaplay/mcp` |
| `plugins/susaplay` | The Claude Code and Cursor plugin: skills in `skills/`, MCP servers in `.mcp.json` (Claude Code) and `mcp.json` (Cursor), and `server/susaplay-mcp.mjs`, the bundled server generated from the source |
| `.claude-plugin/marketplace.json` | The Claude Code marketplace, named `susaplay` |
| `.cursor-plugin/marketplace.json` | The Cursor marketplace. The plugin's Cursor manifest is `plugins/susaplay/.cursor-plugin/plugin.json`, with its MCP servers in `mcp.json` (pinned, so Cursor never reads Claude Code's `.mcp.json`) |

## Development

Development needs Node.js 22.12 or later; the bundled server runs on Node.js 20 or later.

```bash
npm ci
npm test
npm run build   # rebuilds plugins/susaplay/server/susaplay-mcp.mjs — commit it with your change
```

CI fails if the committed bundle differs from what the source produces.

## Releasing

1. In a pull request, set the version in `packages/mcp-server/package.json`
   (`npm version X.Y.Z -w @susaplay/mcp --no-git-tag-version`) and the same version in
   `plugins/susaplay/.claude-plugin/plugin.json` and `plugins/susaplay/.cursor-plugin/plugin.json` — CI checks they match, and Claude Code only
   updates an installed plugin when this version changes. Run `npm run build`, commit the rebuilt
   bundle with it, and check the plugin:
   `claude plugin validate --strict ./plugins/susaplay` and `claude plugin validate --strict .`.
2. After it is merged, a maintainer tags that commit of `main` and pushes the tag:
   `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `release` workflow checks that the tag matches the version and is on `main`, rebuilds and
   tests, publishes to npm through trusted publishing with provenance, and creates the GitHub
   release.

## License

[Apache License 2.0](LICENSE).
