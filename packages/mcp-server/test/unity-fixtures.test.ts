// The checks against files Unity itself wrote (test/fixtures/unity6-addressables).
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ApiClient } from "../src/api/client.js";
import { checkProject } from "../src/tools/check-project.js";
import { inspectBuild } from "../src/tools/inspect-build.js";
import { readAddressablesSetup } from "../src/unity/addressables.js";
import { openBuild } from "../src/unity/build-source.js";
import { RUNTIME_PATH, readCatalogBundles } from "../src/unity/catalog.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/unity6-addressables/", import.meta.url));
const LOCAL = "defaultlocalgroup_assets_all_1d64699ecd548f630f655b461e1e6f00.bundle";
const REMOTE = "remotecontent_assets_all_0609c35207ae0f48b888daa98ef8f4c0.bundle";
const offline = new ApiClient({ apiKey: null, apiBaseUrl: "https://api.test" });

async function inspect(buildDir: string, options: { serverDataPath?: string; gameId?: string } = {}) {
  const build = await openBuild(buildDir);
  try {
    return await inspectBuild(build, { api: offline, ...options });
  } finally {
    await build.close();
  }
}

describe("a catalog Unity wrote", () => {
  it("reads the local and the remote bundle with their full locations", () => {
    expect(readCatalogBundles(readFileSync(join(FIXTURE, "serverData/catalog_1.bin")))).toEqual([
      { internalId: `${RUNTIME_PATH}/WebGL/${LOCAL}`, fileName: LOCAL, local: true },
      { internalId: `https://games.susaplay.com/addressables/test-game/${REMOTE}`, fileName: REMOTE, local: false },
    ]);
  });
});

describe("a project Unity wrote", () => {
  it("reads its groups, profile paths and catalog settings", async () => {
    const setup = await readAddressablesSetup(join(FIXTURE, "project"));
    expect(setup).toMatchObject({ buildRemoteCatalog: true, enableJsonCatalog: false, playerVersionOverride: "1", activeProfile: "Default" });
    expect(setup?.groups.map(({ name, isDefault, remote, bundleNaming }) => ({ name, isDefault, remote, bundleNaming }))).toEqual([
      { name: "Default Local Group", isDefault: true, remote: false, bundleNaming: 0 },
      { name: "Remote Content", isDefault: false, remote: true, bundleNaming: 0 },
    ]);
  });

  it("reports what this setup is missing, and only that", async () => {
    // No SusaPlay SDK in the test project, and a local default group.
    const report = await checkProject(join(FIXTURE, "project"), offline);
    expect(report.findings.map((finding) => finding.id)).toEqual(["SP001", "SP003", "SP012"]);
    expect(report.addressablesVersion).toBe("2.9.1");
  });
});

describe("a build and content Unity wrote together", () => {
  it("passes against the content built with it", async () => {
    const report = await inspect(join(FIXTURE, "build"), { serverDataPath: join(FIXTURE, "serverData"), gameId: "test-game" });
    expect(report).toMatchObject({ passed: true, catalogChecked: "serverData", findings: [] });
    expect(report.remoteCatalogUrl).toBe("https://games.susaplay.com/addressables/test-game/catalog_1.hash");
  });

  it("fails when the build lacks a bundle the content expects inside it, as on 2026-09-30", async () => {
    const copy = mkdtempSync(join(tmpdir(), "susaplay-fixture-"));
    try {
      cpSync(join(FIXTURE, "build"), copy, { recursive: true });
      rmSync(join(copy, "StreamingAssets/aa/WebGL", LOCAL));
      const report = await inspect(copy, { serverDataPath: join(FIXTURE, "serverData") });
      expect(report.findings.map((finding) => finding.id)).toEqual(["B012"]);
      expect(report.findings[0]?.message).toContain(LOCAL);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it("fails for another game's ID: the build and the content point at test-game", async () => {
    const report = await inspect(join(FIXTURE, "build"), { serverDataPath: join(FIXTURE, "serverData"), gameId: "another-game" });
    expect(report.findings.map((finding) => finding.id)).toEqual(["B010", "B014"]);
  });
});
