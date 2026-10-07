export const MINIMUM_NODE_MAJOR = 20;

/** `null` when this Node.js can run the server, else what to tell the user. */
export function unsupportedNodeMessage(version: string = process.versions.node): string | null {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major >= MINIMUM_NODE_MAJOR) {
    return null;
  }
  return (
    `The SusaPlay MCP server needs Node.js ${MINIMUM_NODE_MAJOR} or later; this is Node.js ${version}. ` +
    "Install the current LTS release from https://nodejs.org and restart your editor."
  );
}
