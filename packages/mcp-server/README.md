# @susaplay/mcp

The [SusaPlay](https://susaplay.com) MCP server. It lets an AI coding assistant check a Unity
project's SusaPlay setup, inspect and publish WebGL builds, and read your games and analytics.

It runs on your machine over stdio and talks only to the SusaPlay API, with your developer API key.

## Requirements

- Node.js 20 or later.
- A SusaPlay developer API key. Create one in the
  [Developer Portal](https://dev.susaplay.com) under **API Keys**; the **AI assistant** preset is
  recommended. Set it in your assistant's MCP configuration — never paste it into a chat.

## Setup

### Claude Code

```bash
claude mcp add susaplay -e SUSAPLAY_API_KEY=<your key> -- npx -y @susaplay/mcp
```

### Cursor

In `~/.cursor/mcp.json`, or `.cursor/mcp.json` in the project:

```json
{
  "mcpServers": {
    "susaplay": {
      "command": "npx",
      "args": ["-y", "@susaplay/mcp"],
      "env": { "SUSAPLAY_API_KEY": "<your key>" }
    }
  }
}
```

On Windows, if the server does not start, use `"command": "cmd"` with
`"args": ["/c", "npx", "-y", "@susaplay/mcp"]`.

Without a key the server still starts: the local checks work, and the tools that need the API say
where to set it.

## Tools

| Tool | What it does | Changes anything |
| --- | --- | --- |
| `list_games` | Your games: what is live, the latest build and its status, Addressables, the game key | No |
| `get_game` | One game with every build, the retention policy and which builds the next upload deletes | No |
| `get_addressables` | A game's live and staged Addressables content | No |
| `get_analytics` | Daily and 30-day active players, and D1/D7/D30 retention. No revenue | No |
| `check_project` | Checks a Unity project's SusaPlay SDK and Addressables setup | No |
| `inspect_build` | Checks a WebGL build against SusaPlay's upload rules, and its Addressables catalog against the content it loads | No |
| `sync_simulator_config` | Writes the game's configuration for the Editor Simulator into the Unity project | The project file only |
| `publish_build` | Uploads a WebGL build for review | Yes: a new build in review; retention may delete old builds that are not live or in review |
| `create_preview_link` | A single-use, 30-minute link to play a build in review | Yes: a preview session |

Each tool needs the matching permission on the API key: reading games, reading analytics, or
uploading builds.

## Configuration

| Variable | |
| --- | --- |
| `SUSAPLAY_API_KEY` | Your developer API key |

The server writes nothing to stdout except the protocol, and logs to stderr without the key.

## Source and security

Source, issues and releases: [github.com/Susa-Games/susaplay-ai](https://github.com/Susa-Games/susaplay-ai).
Releases are published from GitHub Actions with npm provenance. To report a vulnerability, see
[SECURITY.md](https://github.com/Susa-Games/susaplay-ai/blob/main/SECURITY.md).

## License

Apache-2.0. The package is a single bundled file; the licenses of the third-party packages in it
are kept at its end.
