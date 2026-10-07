import { afterAll, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../src/api/client.js";
import { checkProject } from "../src/tools/check-project.js";
import { removeTempDirs } from "./support/temp.js";
import { makeProject } from "./support/unity-project.js";

afterAll(removeTempDirs);

const offline = new ApiClient({ apiKey: null, apiBaseUrl: "https://api.test" });

function online(games: object[]) {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { games } }), { status: 200 }));
  return new ApiClient({ apiKey: "spdk_test", apiBaseUrl: "https://api.test" }, { fetch });
}

const ids = async (root: string, api = offline) => (await checkProject(root, api)).findings.map((finding) => finding.id);

describe("checkProject", () => {
  it("passes a correctly set-up project, and matches its game with a key", async () => {
    const root = makeProject({ simulatorGameKey: "gk_test", addressables: {} });
    const report = await checkProject(root, online([{ gameId: "g1", name: "Space Run", gameKey: "gk_test" }]));
    expect(report.findings).toEqual([]);
    expect(report.game).toEqual({ gameId: "g1", name: "Space Run" });
  });

  it("finds a missing SDK, an old SDK, and a missing or empty game key", async () => {
    expect(await ids(makeProject({ sdkVersion: null }))).toContain("SP001");
    expect(await ids(makeProject({ sdkVersion: "1.4.1" }))).toContain("SP002");
    expect(await ids(makeProject({ gameKey: null }))).toContain("SP003");
    expect(await ids(makeProject({ gameKey: "''" }))).toContain("SP003");
  });

  it("checks the game key against the developer's games only with a key", async () => {
    const root = makeProject({ simulatorGameKey: "gk_test" });
    expect((await checkProject(root, offline)).findings).toEqual([expect.objectContaining({ id: "SP004", severity: "info" })]);
    expect(await ids(root, online([{ gameId: "g2", gameKey: "gk_other" }]))).toEqual(["SP004"]);
  });

  it("reports a missing or foreign Editor Simulator configuration", async () => {
    expect(await ids(makeProject())).toContain("SP005");
    expect(await ids(makeProject({ simulatorGameKey: "gk_other" }))).toContain("SP006");
  });

  it("finds the Addressables mistakes behind broken content", async () => {
    const api = online([{ gameId: "g1", gameKey: "gk_test" }]);
    const check = (addressables: object, webglDefines?: string[]) =>
      ids(makeProject({ simulatorGameKey: "gk_test", addressables, webglDefines }), api);
    expect(await check({ remoteLoadPath: "https://games.susaplay.com/addressables/another-game" })).toEqual(["SP010"]);
    expect(await check({ remoteLoadPath: "http://localhost:8080/ServerData" })).toEqual(["SP010"]);
    expect(await check({ buildRemoteCatalog: false })).toEqual(["SP011"]);
    // The 2026-09-30 setup: built-in data in a local default group.
    expect(await check({ defaultGroupRemote: false })).toEqual(["SP012"]);
    expect(await check({ playerVersionOverride: "'[UnityEditor.PlayerSettings.bundleVersion]'" })).toEqual(["SP013"]);
    expect(await check({ playerVersionOverride: "" })).toEqual(["SP013"]);
    expect(await check({ remoteBundleNaming: 1 })).toEqual(["SP014"]);
    expect(await check({ enableJsonCatalog: true })).toEqual(["SP015"]);
    expect(await check({ version: "1.21.2" })).toEqual(["SP015"]);
    expect(await check({ version: "1.21.19" })).toEqual(["SP015"]);
    expect(await check({ version: "1.21.19" }, ["ENABLE_BINARY_CATALOG"])).toEqual([]);
  });

  it("says so instead of guessing when the project is not text-serialized", async () => {
    expect(await ids(makeProject({ binarySerialization: true }))).toContain("SP020");
  });
});
