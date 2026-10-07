import { McpServer } from "@modelcontextprotocol/server";

import { SERVER_NAME, SERVER_VERSION } from "./version.js";

/**
 * One server instance per connection. `serveStdio` calls this once the client's
 * opening exchange has chosen the protocol revision, so the same factory serves
 * both the 2025-11-25 and the 2026-07-28 revisions.
 */
export function createServer(): McpServer {
  return new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
}
