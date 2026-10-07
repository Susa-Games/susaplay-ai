# SusaPlay AI tools

Tools that let AI coding assistants work with [SusaPlay](https://susaplay.com): check a Unity
project's SusaPlay setup, inspect and publish WebGL builds, and read your games and analytics.

> **Status:** in development. Nothing is released yet.

## Contents

| Path | What it is |
| --- | --- |
| `packages/mcp-server` | Source of the MCP server, published to npm as `@susaplay/mcp` |
| `plugins/susaplay` | The Claude Code and Cursor plugin. `server/susaplay-mcp.mjs` is the bundled server, generated from the source |

## Development

Development needs Node.js 22.12 or later; the bundled server runs on Node.js 20 or later.

```bash
npm ci
npm test
npm run build   # rebuilds plugins/susaplay/server/susaplay-mcp.mjs — commit it with your change
```

CI fails if the committed bundle differs from what the source produces.

## License

[Apache License 2.0](LICENSE).
