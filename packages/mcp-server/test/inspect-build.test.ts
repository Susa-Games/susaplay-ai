import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../src/api/client.js";
import { inspectBuild } from "../src/tools/inspect-build.js";
import { openBuild } from "../src/unity/build-source.js";
import { RUNTIME_PATH } from "../src/unity/catalog.js";
import { writeCatalog } from "./support/catalog-writer.js";
import { removeTempDirs, tempDir } from "./support/temp.js";
import { writeZip } from "./support/zip-writer.js";

afterAll(removeTempDirs);

const BASE = "https://games.susaplay.com/addressables/g1/";
const offline = new ApiClient({ apiKey: null, apiBaseUrl: "https://api.test" });

// The two Addressables builds of 2026-09-30: the player shipped one, the
// published content came from the other.
const PLAYER_LOCAL = "21dbcbd88f25e08ec7682784c2c4e419_unitybuiltinassets_b07a279c.bundle";
const CONTENT_LOCAL = "872f08144a4ec7f40cbd3f2947356f9b_unitybuiltinassets_5c3bbd31.bundle";

function buildFiles(options: { localBundles?: string[]; catalogUrl?: string | null; extra?: Record<string, string | Uint8Array> } = {}) {
  const files: Record<string, string | Uint8Array> = {
    "index.html": "<html></html>",
    "Build/game.loader.js": "loader",
    ...options.extra,
  };
  if (options.catalogUrl !== null) {
    const url = options.catalogUrl ?? `${BASE}catalog_1.hash`;
    files["StreamingAssets/aa/settings.json"] = JSON.stringify({
      m_CatalogLocations: [{ m_Keys: ["AddressablesMainContentCatalogRemoteHash"], m_InternalId: url }],
    });
    const local = options.localBundles ?? [PLAYER_LOCAL];
    files["StreamingAssets/aa/catalog.bin"] = writeCatalog(local.map((name) => `${RUNTIME_PATH}/WebGL/${name}`));
    for (const name of local) files[`StreamingAssets/aa/WebGL/${name}`] = "bundle";
  }
  return files;
}

function folder(files: Record<string, string | Uint8Array>): string {
  const root = tempDir("susaplay-build-");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

function serverData(catalogName: string, bundleIds: string[], files: string[]): string {
  const root = tempDir("susaplay-serverdata-");
  writeFileSync(join(root, catalogName), writeCatalog(bundleIds));
  writeFileSync(join(root, catalogName.replace(/\.bin$/, ".hash")), "hash");
  for (const file of files) writeFileSync(join(root, file), "bundle");
  return root;
}

async function inspect(path: string, options: { gameId?: string; serverDataPath?: string; api?: ApiClient; fetch?: typeof fetch } = {}) {
  const build = await openBuild(path);
  try {
    const report = await inspectBuild(build, { api: offline, ...options });
    return { report, ids: report.findings.map((finding) => finding.id) };
  } finally {
    await build.close();
  }
}

describe("inspectBuild: upload rules", () => {
  it("passes a build folder and its zip alike, with a single root folder stripped", async () => {
    const files = buildFiles();
    expect((await inspect(folder(files))).report.passed).toBe(true);
    const wrapped = Object.fromEntries(Object.entries(files).map(([name, content]) => [`WebGLBuild/${name}`, content]));
    const zip = join(tempDir("susaplay-zip-"), "build.zip");
    writeFileSync(zip, writeZip(wrapped, { deflate: true }));
    const { report } = await inspect(zip);
    expect(report).toMatchObject({ passed: true, kind: "zip", fileCount: Object.keys(files).length });
  });

  it("refuses a build without index.html or loader, and one with too many entries", async () => {
    expect((await inspect(folder({ "game.html": "x", "Build/game.loader.js": "x" }))).ids).toContain("B001");
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`Build/chunk${index}.js`, "x"]));
    expect((await inspect(folder(buildFiles({ extra: many })))).ids).toContain("B002");
  });

  it("lists operating-system junk, and warns about an archive inside the build", async () => {
    const { ids, report } = await inspect(folder(buildFiles({ extra: { ".DS_Store": "x", "Build/Thumbs.db": "x", "Archive.zip": "x" } })));
    expect(ids).toEqual(["B007", "B006"]);
    expect(report.passed).toBe(true);
  });
});

describe("inspectBuild: Addressables content", () => {
  it("catches the 2026-09-30 mismatch: content built with another player build", async () => {
    const content = serverData("catalog_1.bin", [`${RUNTIME_PATH}/WebGL/${CONTENT_LOCAL}`, `${BASE}levels_ab12.bundle`], ["levels_ab12.bundle"]);
    const { report, ids } = await inspect(folder(buildFiles()), { serverDataPath: content });
    expect(ids).toEqual(["B012"]);
    expect(report.passed).toBe(false);
    expect(report.findings[0]?.message).toContain(CONTENT_LOCAL);
  });

  it("passes content built together with the build", async () => {
    const content = serverData("catalog_1.bin", [`${RUNTIME_PATH}/WebGL/${PLAYER_LOCAL}`, `${BASE}levels_ab12.bundle`], ["levels_ab12.bundle"]);
    expect((await inspect(folder(buildFiles()), { serverDataPath: content })).ids).toEqual([]);
  });

  it("finds a catalog the build will never request, missing remote bundles, and another game's path", async () => {
    const renamed = serverData("catalog_2.bin", [], []);
    expect((await inspect(folder(buildFiles()), { serverDataPath: renamed })).ids).toEqual(["B011"]);
    const incomplete = serverData("catalog_1.bin", [`${BASE}levels_ab12.bundle`], []);
    expect((await inspect(folder(buildFiles()), { serverDataPath: incomplete })).ids).toEqual(["B013"]);
    const foreign = serverData("catalog_1.bin", ["https://games.susaplay.com/addressables/other/x_1.bundle"], ["x_1.bundle"]);
    expect((await inspect(folder(buildFiles()), { serverDataPath: foreign, gameId: "g1" })).ids).toEqual(["B014"]);
  });

  it("flags a build whose remote catalog points elsewhere, and one with none", async () => {
    expect((await inspect(folder(buildFiles({ catalogUrl: "http://localhost:8080/catalog_1.hash" })))).ids).toContain("B010");
    expect((await inspect(folder(buildFiles({ catalogUrl: null })))).ids).toEqual([]);
    const url = { m_CatalogLocations: [{ m_Keys: ["AddressablesMainContentCatalog"], m_InternalId: "x" }] };
    expect((await inspect(folder({ ...buildFiles({ catalogUrl: null }), "StreamingAssets/aa/settings.json": JSON.stringify(url) }))).ids).toEqual(["B017"]);
  });

  it("compares with the live content, fetching only this game's public catalog", async () => {
    const liveCatalog = writeCatalog([`${RUNTIME_PATH}/WebGL/${CONTENT_LOCAL}`]);
    const fetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`${BASE}catalog_1.bin`);
      return new Response(liveCatalog, { status: 200 });
    });
    const { ids } = await inspect(folder(buildFiles()), { gameId: "g1", fetch: fetch as typeof globalThis.fetch });
    expect(ids).toEqual(["B016", "B012"]);

    // A build naming another host is reported, never fetched from.
    const elsewhere = vi.fn();
    const result = await inspect(folder(buildFiles({ catalogUrl: "https://evil.example/catalog_1.hash" })), {
      gameId: "g1",
      fetch: elsewhere as unknown as typeof globalThis.fetch,
    });
    expect(elsewhere).not.toHaveBeenCalled();
    expect(result.ids).toEqual(["B010"]);
  });

  it("accepts the double slash Unity writes for a Remote Load Path ending in '/', and fetches the clean URL", async () => {
    const liveCatalog = writeCatalog([`${RUNTIME_PATH}/WebGL/${PLAYER_LOCAL}`]);
    const fetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`${BASE}catalog_1.bin`);
      return new Response(liveCatalog, { status: 200 });
    });
    const { ids } = await inspect(folder(buildFiles({ catalogUrl: `${BASE}/catalog_1.hash` })), { gameId: "g1", fetch: fetch as typeof globalThis.fetch });
    expect(fetch).toHaveBeenCalledOnce();
    expect(ids).not.toContain("B010");
    // A deeper path is not served by the CDN.
    const deeper = await inspect(folder(buildFiles({ catalogUrl: `${BASE}v2/catalog_1.hash` })), { gameId: "g1", fetch: vi.fn() as unknown as typeof globalThis.fetch });
    expect(deeper.ids).toContain("B010");
  });
});
