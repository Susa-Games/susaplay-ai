// Starts the bundled server with this Node.js and completes the MCP handshake.
// Plain Node, no test runner, so CI can run it on every supported Node.js and
// operating system — including Node.js 20, which the dev tools do not support.
//
//   node scripts/smoke.mjs <path to susaplay-mcp.mjs>
import { spawn } from "node:child_process";

const bundle = process.argv[2];
if (!bundle) {
  console.error("usage: node scripts/smoke.mjs <bundle>");
  process.exit(2);
}

const child = spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
const fail = (reason) => {
  console.error(`smoke test failed on Node.js ${process.versions.node} (${process.platform}): ${reason}`);
  console.error(`stdout: ${stdout}\nstderr: ${stderr}`);
  child.kill();
  process.exit(1);
};
const timer = setTimeout(() => fail("no answer within 10 seconds"), 10_000);

child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  // A long message arrives in several chunks: only lines ended by a newline are
  // whole messages.
  const lines = stdout.split("\n").slice(0, -1).filter((line) => line.trim());
  if (lines.length < 2) return;
  clearTimeout(timer);
  let initialize;
  let tools;
  try {
    [initialize, tools] = lines.map((line) => JSON.parse(line));
  } catch {
    fail("stdout carried something that is not a protocol message");
  }
  if (initialize?.result?.serverInfo?.name !== "susaplay") fail("unexpected initialize answer");
  if (!Array.isArray(tools?.result?.tools)) fail("unexpected tools/list answer");
  console.log(
    `ok: ${initialize.result.serverInfo.name} ${initialize.result.serverInfo.version} on Node.js ${process.versions.node} (${process.platform}), ${tools.result.tools.length} tools`,
  );
  child.stdin.end();
  child.kill();
  process.exit(0);
});

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
