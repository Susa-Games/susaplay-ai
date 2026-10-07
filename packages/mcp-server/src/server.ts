import { McpServer } from "@modelcontextprotocol/server";

import { ApiClient } from "./api/client.js";
import { type Config, readConfig } from "./config.js";
import { registerAddressablesTools } from "./tools/addressables.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerCheckProjectTool } from "./tools/check-project.js";
import { registerGameTools } from "./tools/games.js";
import { registerInspectBuildTool } from "./tools/inspect-build.js";
import { registerSimulatorTools } from "./tools/simulator.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export interface ServerDependencies {
  config?: Config;
  fetch?: typeof fetch;
  cwd?: () => string;
}

/**
 * One server instance per connection. `serveStdio` calls this once the client's
 * opening exchange has chosen the protocol revision, so the same factory serves
 * both the 2025-11-25 and the 2026-07-28 revisions.
 */
export function createServer(dependencies: ServerDependencies = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  const api = new ApiClient(dependencies.config ?? readConfig(), {
    fetch: dependencies.fetch,
    clientName: () => server.server.getClientVersion()?.name,
  });
  registerGameTools(server, api);
  registerAddressablesTools(server, api);
  registerAnalyticsTools(server, api);
  registerSimulatorTools(server, api, dependencies.cwd);
  registerCheckProjectTool(server, api, dependencies.cwd);
  registerInspectBuildTool(server, api, dependencies.cwd, dependencies.fetch);
  return server;
}
