import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { log } from "./log.js";
import { unsupportedNodeMessage } from "./runtime.js";
import { readConfig } from "./config.js";
import { createServer } from "./server.js";
import { SERVER_VERSION } from "./version.js";

const unsupported = unsupportedNodeMessage();
if (unsupported) {
  log(unsupported);
  process.exit(1);
}

let config;
try {
  config = readConfig();
} catch (error) {
  log((error as Error).message);
  process.exit(1);
}
log(`starting ${SERVER_VERSION}${config.apiKey ? "" : " without an API key: only local tools will work"}`);
serveStdio(() => createServer({ config }), {
  onerror: (error) => log(`error: ${error.message}`),
});
