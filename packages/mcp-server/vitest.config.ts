import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: { __SUSAPLAY_MCP_VERSION__: JSON.stringify(version) },
  test: { include: ["test/**/*.test.ts"], globalSetup: ["test/global-setup.ts"] },
});
