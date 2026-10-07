# SusaPlay AI tools

Tools that let AI coding assistants work with [SusaPlay](https://susaplay.com): check a Unity
project's SusaPlay setup, inspect and publish WebGL builds, and read your games and analytics.

> **Status:** the MCP server is on npm as [`@susaplay/mcp`](https://www.npmjs.com/package/@susaplay/mcp)
> for manual setup ([setup](packages/mcp-server/README.md)). The Claude Code and Cursor plugins are
> in development.

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

## Releasing

1. In a pull request, set the version in `packages/mcp-server/package.json`
   (`npm version X.Y.Z -w @susaplay/mcp --no-git-tag-version`), run `npm run build`, and commit
   the rebuilt bundle with it.
2. After it is merged, a maintainer tags that commit of `main` and pushes the tag:
   `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `release` workflow checks that the tag matches the version and is on `main`, rebuilds and
   tests, publishes to npm through trusted publishing with provenance, and creates the GitHub
   release.

## License

[Apache License 2.0](LICENSE).
