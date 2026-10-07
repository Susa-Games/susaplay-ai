// The bundled server, run as a client runs it, against a fake SusaPlay API on
// this machine and a throwaway Unity project.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { McpSession } from "./mcp-session.js";

const KEY = "spdk_e2e_secret";
const GAME = {
  gameId: "g1",
  name: "Space Run",
  status: "live",
  gameKey: "gk_space",
  liveWebglVersionId: "1.0.1",
  latestVersion: { versionId: "1.0.2", status: "pending_review", uploadedAt: "2026-10-06T10:00:00+00:00" },
  buildSummary: { pendingReviewCount: 1, processingCount: 0, versionCount: 2 },
  addressables: { enabled: true, status: "active", liveCatalogVersion: "7", liveFileCount: 3, livePublishedAt: "2026-10-01T00:00:00+00:00" },
};
const SIMULATOR_CONFIG = {
  format: 1,
  exportedAt: "2026-10-07T00:00:00+00:00",
  game: { gameId: "g1", gameKey: "gk_space", name: "Space Run" },
  achievements: [{ achievementId: "first_win" }],
  items: { sword: { name: "Sword" } },
};

const routes: Record<string, unknown> = {
  "/catalog/games": { games: [GAME, { ...GAME, gameId: "g2", name: "Other", gameKey: "gk_other" }] },
  "/catalog/game/g1": { game: GAME, retention: { maxVersionsPerPlatform: 5, minAgeHours: 24, maxPendingPerGame: 3 } },
  "/catalog/game/g1/versions": {
    versions: [
      { versionId: "1.0.2", platform: "webgl", status: "pending_review", uploadedAt: "2026-10-06T10:00:00+00:00", notes: "new\u0000 levels" },
      { versionId: "1.0.1", platform: "webgl", status: "live", uploadedAt: "2026-09-01T10:00:00+00:00" },
    ],
  },
  "/catalog/game/g1/addressables": {
    enabled: true,
    status: "active",
    remoteLoadPath: "https://games.susaplay.com/addressables/g1/",
    liveCatalogVersion: "7",
    livePublishedAt: "2026-10-01T00:00:00+00:00",
    live: [{ filename: "catalog_7.bin", sizeBytes: 100 }, { filename: "a.bundle", sizeBytes: 900 }],
    staging: [{ filename: "catalog_8.bin", fileType: "catalog_bin", sizeBytes: 120 }],
    stagingReadiness: { hasCatalogBin: true, hasCatalogHash: false, bundleCount: 0, catalogVersion: "8", readyToPublish: false },
  },
  "/analytics/dashboard": {
    gameId: "g1",
    days: 7,
    dates: ["2026-10-01", "2026-10-02"],
    dau: [0, 4],
    mau: [3, 5],
    revenue: [9.99, 0],
    retention: { d1: 0.5, d7: 0.25, d30: null },
  },
  "/catalog/game/g1/simulator-config": SIMULATOR_CONFIG,
  "/catalog/game/g1/versions/1.0.2/preview-session": {
    sessionId: "s1",
    gameId: "g1",
    versionId: "1.0.2",
    launchToken: "lt one",
    expiresAt: "2026-10-07T12:30:00+00:00",
  },
};

let api: Server;
let baseUrl: string;
const seen: IncomingMessage[] = [];
let project: string;
const sessions: McpSession[] = [];

function session(env: Record<string, string> = {}): McpSession {
  const started = new McpSession({
    cwd: project,
    env: { SUSAPLAY_API_KEY: KEY, SUSAPLAY_API_BASE_URL: baseUrl, ...env },
  });
  sessions.push(started);
  return started;
}

beforeAll(async () => {
  api = createServer((request, response) => {
    seen.push(request);
    const path = (request.url ?? "").split("?")[0] ?? "";
    const data = routes[path];
    if (request.headers.authorization !== `ApiKey ${KEY}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: false, error: { code: "UNAUTHENTICATED", message: "Invalid API key" } }));
      return;
    }
    response.writeHead(data ? 200 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(data ? { success: true, data } : { success: false, error: { code: "NOT_FOUND", message: "Game not found" } }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "susaplay-unity-"));
  mkdirSync(join(project, "Assets/Resources"), { recursive: true });
  mkdirSync(join(project, "ProjectSettings"), { recursive: true });
  writeFileSync(
    join(project, "Assets/Resources/PlatformConfig.asset"),
    "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!114 &11400000\nMonoBehaviour:\n  _gameKey: gk_space\n",
  );
});

afterEach(() => {
  while (sessions.length) sessions.pop()?.close();
});

afterAll(() => {
  api.close();
  rmSync(project, { recursive: true, force: true });
});

describe("read tools against the API", () => {
  it("lists every tool: reads as read-only, sync, publish and preview as writes", async () => {
    const mcp = session();
    await mcp.open();
    const { result } = await mcp.request("tools/list");
    const tools = Object.fromEntries(result.tools.map((tool: any) => [tool.name, tool]));
    expect(Object.keys(tools).sort()).toEqual([
      "check_project",
      "create_preview_link",
      "get_addressables",
      "get_analytics",
      "get_game",
      "inspect_build",
      "list_games",
      "publish_build",
      "sync_simulator_config",
    ]);
    for (const name of ["list_games", "get_game", "get_addressables", "get_analytics", "check_project", "inspect_build"]) {
      expect(tools[name].annotations.readOnlyHint).toBe(true);
      expect(tools[name].outputSchema).toBeDefined();
    }
    expect(tools.sync_simulator_config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    for (const name of ["publish_build", "create_preview_link"]) {
      expect(tools[name].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    }
    expect(tools.publish_build.description).toContain("Retention");
  });

  it("list_games shows names first and sends the key with a User-Agent naming the client", async () => {
    const mcp = session();
    await mcp.open();
    const result = await mcp.callTool("list_games");
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Space Run (g1), live 1.0.1, latest 1.0.2 pending_review, 1 in review");
    expect(result.structuredContent.games[0]).toMatchObject({ name: "Space Run", gameKey: "gk_space", pendingReviewCount: 1 });
    const request = seen.at(-1)!;
    expect(request.headers["user-agent"]).toMatch(/^susaplay-mcp\/\S+ \(test-client\)$/);
  });

  it("get_game lists builds with cleaned notes and forecasts retention", async () => {
    const mcp = session();
    await mcp.open();
    const result = await mcp.callTool("get_game", { gameId: "g1" });
    expect(result.structuredContent.versions[0]).toMatchObject({ versionId: "1.0.2", notes: "new levels" });
    expect(result.structuredContent.retention).toMatchObject({ maxVersionsPerPlatform: 5, deletedByNextUpload: [] });
  });

  it("get_addressables says what staging is missing", async () => {
    const mcp = session();
    await mcp.open();
    const result = await mcp.callTool("get_addressables", { gameId: "g1" });
    expect(result.structuredContent.live).toMatchObject({ fileCount: 2, totalBytes: 1000, catalogVersion: "7" });
    expect(result.structuredContent.staging.missing).toEqual([
      "the catalog hash (catalog_<version>.hash)",
      "at least one .bundle file",
    ]);
  });

  it("get_analytics reports activity and leaves revenue out", async () => {
    const mcp = session();
    await mcp.open();
    const result = await mcp.callTool("get_analytics", { gameId: "g1", days: 7 });
    expect(result.structuredContent).toMatchObject({ dau: [0, 4], activeDays: 1, peakDau: 4 });
    expect(result.structuredContent).not.toHaveProperty("revenue");
    expect(seen.at(-1)!.url).toBe("/analytics/dashboard?gameId=g1&days=7");
  });

  it("explains a missing game instead of failing", async () => {
    const mcp = session();
    await mcp.open();
    const result = await mcp.callTool("get_game", { gameId: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Use list_games");
  });
});

describe("create_preview_link", () => {
  it("returns a single-use link on the player site", async () => {
    const mcp = session();
    await mcp.open();
    const result = await mcp.callTool("create_preview_link", { gameId: "g1", versionId: "1.0.2" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      gameId: "g1",
      versionId: "1.0.2",
      url: "https://susaplay.com/play/g1?previewSession=lt%20one",
      expiresAt: "2026-10-07T12:30:00+00:00",
    });
    expect(result.content[0].text).toContain("works once");
    expect(seen.at(-1)!.method).toBe("POST");
  });

  it("explains that only a build in review can be previewed", async () => {
    const mcp = session();
    await mcp.open();
    const result = await mcp.callTool("create_preview_link", { gameId: "g1", versionId: "1.0.1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Only a pending_review build can be previewed");
  });
});

describe("without an API key", () => {
  it("starts, and every API tool says where to set the key", async () => {
    const mcp = session({ SUSAPLAY_API_KEY: "" });
    await mcp.open();
    const result = await mcp.callTool("list_games");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("SUSAPLAY_API_KEY");
    expect(mcp.stderr).toContain("without an API key");
  });
});

describe("sync_simulator_config", () => {
  const file = () => join(project, "ProjectSettings/Packages/com.susaplay.sdk/SimulatorConfig.json");

  it("finds the game by the project's game key and writes the file the portal would", async () => {
    const mcp = session();
    await mcp.open();
    const result = await mcp.callTool("sync_simulator_config");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ gameId: "g1", achievements: 1, items: 1 });
    expect(readFileSync(file(), "utf8")).toBe(`${JSON.stringify(SIMULATOR_CONFIG, null, 2)}\n`);
    expect(result.content[0].text).toContain("Commit the file");
  });

  it("refuses to write another game's configuration into the project", async () => {
    routes["/catalog/game/g2/simulator-config"] = { ...SIMULATOR_CONFIG, game: { gameId: "g2", gameKey: "gk_other", name: "Other" } };
    rmSync(file(), { force: true });
    const mcp = session();
    await mcp.open();
    const result = await mcp.callTool("sync_simulator_config", { gameId: "g2" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Nothing was written");
    expect(() => readFileSync(file())).toThrow();
  });

  it("refuses a folder that is not a Unity project", async () => {
    const mcp = session();
    await mcp.open();
    const result = await mcp.callTool("sync_simulator_config", { projectPath: tmpdir() });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("is not a Unity project");
  });
});
