import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BUNDLE = fileURLToPath(new URL("../dist/susaplay-mcp.mjs", import.meta.url));

/** A JSON-RPC conversation with the bundled server over stdio, as an MCP client has. */
export class McpSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly waiting = new Map<number, (message: any) => void>();
  stderr = "";

  constructor(options: { env?: Record<string, string | undefined>; cwd?: string } = {}) {
    this.child = spawn(process.execPath, [BUNDLE], {
      cwd: options.cwd,
      env: { PATH: process.env.PATH, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        this.waiting.get(message.id)?.(message);
        this.waiting.delete(message.id);
      }
    });
  }

  request(method: string, params: object = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${this.stderr}`)), 10_000);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: object = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async open(): Promise<any> {
    const answer = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0" },
    });
    this.notify("notifications/initialized");
    return answer;
  }

  async callTool(name: string, args: object = {}): Promise<any> {
    return (await this.request("tools/call", { name, arguments: args })).result;
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}
