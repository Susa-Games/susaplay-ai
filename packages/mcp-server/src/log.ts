// stdout carries the MCP protocol: a single stray write there corrupts the
// session. Everything the server says for humans goes to stderr.
export function log(message: string): void {
  process.stderr.write(`[susaplay-mcp] ${message}\n`);
}
