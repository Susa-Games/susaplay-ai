// Replaced at build time (build.mjs) and in tests (vitest.config.ts) with the
// version in package.json. The plugin and the server always share it.
declare const __SUSAPLAY_MCP_VERSION__: string;

export const SERVER_NAME = "susaplay";
export const SERVER_VERSION: string = __SUSAPLAY_MCP_VERSION__;
