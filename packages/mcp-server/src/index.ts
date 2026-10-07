import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { log } from "./log.js";
import { unsupportedNodeMessage } from "./runtime.js";
import { createServer } from "./server.js";
import { SERVER_VERSION } from "./version.js";

const unsupported = unsupportedNodeMessage();
if (unsupported) {
  log(unsupported);
  process.exit(1);
}

log(`starting ${SERVER_VERSION}`);
serveStdio(createServer, {
  onerror: (error) => log(`error: ${error.message}`),
});
