// Runs the bundled file the way Claude Code and Cursor do — `node <file>` over
// stdio — so what is tested is what developers run.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const bundle = fileURLToPath(new URL("../dist/susaplay-mcp.mjs", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

interface Session {
  responses: Array<Record<string, any>>;
  stdout: string;
  stderr: string;
}

/** Writes JSON-RPC messages to the server, waits for `expected` responses, then closes stdin. */
function talk(messages: object[], expected: number): Promise<Session> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out; stdout=${stdout} stderr=${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split("\n").filter((line) => line.trim());
      if (lines.length >= expected) {
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        resolve({ responses: lines.map((line) => JSON.parse(line)), stdout, stderr });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  });
}

describe("the bundled server", () => {
  beforeAll(() => {
    execFileSync(process.execPath, ["build.mjs"], { cwd: packageDir, stdio: "ignore" });
  });

  it("answers the opening handshake with its name and version", async () => {
    const session = await talk(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
      2,
    );

    const [initialize, tools] = session.responses;
    expect(initialize?.result.serverInfo).toEqual({ name: "susaplay", version });
    expect(initialize?.result.capabilities.tools).toBeDefined();
    expect(tools?.id).toBe(2);
    expect(Array.isArray(tools?.result.tools)).toBe(true);
  });

  it("writes only protocol messages to stdout and its own log to stderr", async () => {
    const session = await talk(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } },
        },
      ],
      1,
    );
    for (const line of session.stdout.split("\n").filter((entry) => entry.trim())) {
      expect(JSON.parse(line).jsonrpc).toBe("2.0");
    }
    expect(session.stderr).toContain(`[susaplay-mcp] starting ${version}`);
  });
});
