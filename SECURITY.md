# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub: open the **Security** tab of this
repository and choose **Report a vulnerability**. Do not open a public issue.

Include what you found, how to reproduce it, and which version of the plugin or of
`@susaplay/mcp` you used. We answer within five working days.

## What is in scope

- The MCP server in `packages/mcp-server` and its bundled build in `plugins/susaplay/server`.
- The Claude Code and Cursor plugins in `plugins/susaplay`.

Problems in the SusaPlay platform itself, such as the API at `api.susaplay.com` or the Developer
Portal, can be reported the same way.

## If an API key leaks

Revoke it at once in the SusaPlay Developer Portal under **API Keys**. A revoked key stops working
on its next request. Then create a new key with only the permissions it needs.
