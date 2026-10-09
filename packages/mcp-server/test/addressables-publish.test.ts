import { cpSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ApiClient } from "../src/api/client.js";
import { readContentSet, uploadAddressables } from "../src/tools/addressables-publish.js";
import { ToolInputError } from "../src/tools/result.js";
import { writeCatalog } from "./support/catalog-writer.js";
import { removeTempDirs, tempDir } from "./support/temp.js";

const SERVER_DATA = fileURLToPath(new URL("./fixtures/unity6-addressables/serverData/", import.meta.url));
const GAME = "test-game";
const BUNDLE = "remotecontent_assets_all_0609c35207ae0f48b888daa98ef8f4c0.bundle";
const BASE = `https://games.susaplay.com/addressables/${GAME}/`;

// Storage: records each PUT by path; `failNext` answers 503 that many times first.
let storage: Server;
let storageUrl: string;
let received: Map<string, number>;
let failNext = 0;

beforeAll(async () => {
  storage = createServer((request, response) => {
    let size = 0;
    request.on("data", (chunk: Buffer) => (size += chunk.length));
    request.on("end", () => {
      if (failNext > 0) {
        failNext -= 1;
        response.writeHead(503);
        response.end();
        return;
      }
      received.set(request.url ?? "", size);
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise<void>((resolve) => storage.listen(0, "127.0.0.1", resolve));
  storageUrl = `http://127.0.0.1:${(storage.address() as AddressInfo).port}`;
});

afterAll(() => {
  storage.close();
  removeTempDirs();
});

/** A copy of the fixture's content, plus whatever a test adds. */
function contentFolder(extra: Record<string, Uint8Array | string> = {}): string {
  const dir = tempDir("susaplay-content-");
  cpSync(SERVER_DATA, dir, { recursive: true });
  for (const [name, data] of Object.entries(extra)) writeFileSync(join(dir, name), data);
  return dir;
}

interface Fake {
  calls: string[];
  bodies: Array<{ path: string; body: any }>;
  staging: Array<{ filename: string; sizeBytes?: number }>;
  live: Array<{ filename: string }>;
  enabled: boolean;
  status: string;
  /** Bundles upload-batch reports as already on SusaPlay. */
  alreadyLive: Set<string>;
  missing: string[];
}

let fake: Fake;

beforeEach(() => {
  received = new Map();
  failNext = 0;
  fake = { calls: [], bodies: [], staging: [], live: [], enabled: true, status: "active", alreadyLive: new Set(), missing: [] };
});

function client(): ApiClient {
  const fetch = async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.test", "");
    fake.calls.push(`${init.method} ${path.replace(`/catalog/game/${GAME}/addressables`, "…")}`);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (body) fake.bodies.push({ path, body });
    const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
    if (path === `/catalog/game/${GAME}/addressables` && init.method === "GET") {
      return reply({
        enabled: fake.enabled,
        status: fake.status,
        remoteLoadPath: BASE,
        staging: fake.staging,
        live: fake.live,
        stagingReadiness: { readyToPublish: fake.staging.length > 0 },
      });
    }
    if (path.endsWith("/upload-batch")) {
      const files = body.files as Array<{ filename: string; sizeBytes: number }>;
      return reply({
        uploads: files
          .filter((file) => !fake.alreadyLive.has(file.filename))
          .map((file) => ({ filename: file.filename, uploadUrl: `${storageUrl}/${file.filename}`, headers: { "Content-Type": "application/octet-stream" } })),
        reused: files.filter((file) => fake.alreadyLive.has(file.filename)).map((file) => ({ filename: file.filename, reason: "already_live" })),
      });
    }
    if (path.endsWith("/register-batch")) {
      const files = body.files as Array<{ filename: string }>;
      fake.staging = files.map((file) => ({ filename: file.filename, sizeBytes: received.get(`/${file.filename}`) ?? 1 }));
      return reply({ registered: files.map((file) => file.filename), missing: fake.missing });
    }
    return new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "no route" } }), { status: 404 });
  };
  return new ApiClient({ apiKey: "spdk_test", apiBaseUrl: "https://api.test" }, { fetch, sleep: async () => undefined });
}

const upload = (dir: string, extra: { catalog?: string; dryRun?: boolean } = {}) =>
  uploadAddressables({ gameId: GAME, serverDataPath: dir, ...extra }, { api: client(), sleep: async () => undefined });

describe("readContentSet", () => {
  it("takes the catalog pair and the remote bundles it names, and ignores older builds' files", async () => {
    const dir = contentFolder({ "remote_old_00000000000000000000000000000000.bundle": "old", "notes.txt": "x" });
    const set = await readContentSet(dir, BASE);
    expect(set.catalog).toBe("catalog_1.bin");
    expect(set.files.map((file) => file.filename)).toEqual(["catalog_1.hash", "catalog_1.bin", BUNDLE]);
    expect(set.ignored).toEqual(["remote_old_00000000000000000000000000000000.bundle"]);
  });

  it("asks which catalog when the folder holds several, and takes the one named", async () => {
    const other = writeCatalog([`${BASE}${BUNDLE}`]);
    const dir = contentFolder({ "catalog_2.bin": other, "catalog_2.hash": "h" });
    await expect(readContentSet(dir, BASE)).rejects.toThrow(/several catalogs: catalog_1.bin, catalog_2.bin/);
    const set = await readContentSet(dir, BASE, "catalog_2");
    expect(set.catalog).toBe("catalog_2.bin");
    expect(set.ignored).toEqual(["catalog_1.bin", "catalog_1.hash"]);
  });

  it("refuses bundles that load from another game's path or a placeholder", async () => {
    const dir = tempDir("susaplay-content-");
    writeFileSync(join(dir, "catalog_1.bin"), writeCatalog([`https://games.susaplay.com/addressables/other-game/${BUNDLE}`]));
    writeFileSync(join(dir, "catalog_1.hash"), "h");
    writeFileSync(join(dir, BUNDLE), "b");
    await expect(readContentSet(dir, BASE)).rejects.toThrow(/other-game.*SP010/s);

    writeFileSync(join(dir, "catalog_1.bin"), writeCatalog([`${BASE}{Profile.Version}/${BUNDLE}`]));
    await expect(readContentSet(dir, BASE)).rejects.toThrow(/somewhere other than/);

    // A deeper path is not served; repeated slashes are.
    writeFileSync(join(dir, "catalog_1.bin"), writeCatalog([`${BASE}v2/${BUNDLE}`]));
    await expect(readContentSet(dir, BASE)).rejects.toThrow(/somewhere other than/);
    writeFileSync(join(dir, "catalog_1.bin"), writeCatalog([`${BASE}/${BUNDLE}`]));
    await expect(readContentSet(dir, BASE)).resolves.toMatchObject({ catalog: "catalog_1.bin" });
  });

  it("refuses a catalog whose bundles are not in the folder, a missing hash, and a JSON catalog", async () => {
    const dir = tempDir("susaplay-content-");
    writeFileSync(join(dir, "catalog_1.bin"), writeCatalog([`${BASE}${BUNDLE}`]));
    await expect(readContentSet(dir, BASE)).rejects.toThrow(/catalog_1.hash is missing/);
    writeFileSync(join(dir, "catalog_1.hash"), "h");
    await expect(readContentSet(dir, BASE)).rejects.toThrow(new RegExp(`names 1 bundle\\(s\\) that are not in .*${BUNDLE}`));

    const json = tempDir("susaplay-content-");
    writeFileSync(join(json, "catalog_1.json"), "{}");
    await expect(readContentSet(json, BASE)).rejects.toThrow(/SP015/);
  });
});

describe("uploadAddressables", () => {
  it("signs, uploads only what SusaPlay lacks, registers everything, and points to the plan", async () => {
    fake.alreadyLive.add(BUNDLE);
    const result = await upload(contentFolder());

    expect(fake.calls).toEqual(["GET …", "POST …/upload-batch", "POST …/register-batch", "GET …"]);
    expect([...received.keys()].sort()).toEqual(["/catalog_1.bin", "/catalog_1.hash"]);
    expect(fake.bodies[1]!.body.files.map((file: { filename: string }) => file.filename)).toEqual(["catalog_1.hash", "catalog_1.bin", BUNDLE]);
    expect(result).toMatchObject({ catalog: "catalog_1.bin", fileCount: 3, uploaded: 2, reused: 1, readyToPublish: true, ignored: [] });
    expect(result.uploadedBytes).toBe(2281 + 32);
    expect(result.nextStep).toContain("plan_addressables_publish");
  });

  it("retries a failed PUT with backoff", async () => {
    failNext = 2;
    const result = await upload(contentFolder());
    expect(result.uploaded).toBe(3);
    expect(received.size).toBe(3);
  });

  it("refuses when staging holds another upload's files, before sending anything", async () => {
    fake.staging = [{ filename: "catalog_0.bin" }, { filename: "catalog_1.bin" }];
    await expect(upload(contentFolder())).rejects.toThrow(/staging already holds 1 file\(s\).*catalog_0.bin/s);
    expect(fake.calls).toEqual(["GET …"]);
  });

  it("checks bundle locations against the Remote Load Path the API gives", async () => {
    const dir = tempDir("susaplay-content-");
    writeFileSync(join(dir, "catalog_1.bin"), writeCatalog([`https://games.staging.test/addressables/${GAME}/${BUNDLE}`]));
    writeFileSync(join(dir, "catalog_1.hash"), "h");
    writeFileSync(join(dir, BUNDLE), "b");
    await expect(readContentSet(dir, `https://games.staging.test/addressables/${GAME}/`)).resolves.toMatchObject({ catalog: "catalog_1.bin" });
    await expect(upload(dir)).rejects.toThrow(/somewhere other than/);
  });

  it("refuses when Addressables are off or suspended", async () => {
    fake.enabled = false;
    await expect(upload(contentFolder())).rejects.toThrow(/not enabled/);
    fake.enabled = true;
    fake.status = "suspended";
    await expect(upload(contentFolder())).rejects.toThrow(/suspended/);
  });

  it("reports a file SusaPlay did not receive", async () => {
    fake.missing = [BUNDLE];
    await expect(upload(contentFolder())).rejects.toBeInstanceOf(ToolInputError);
  });

  it("sends nothing on a dry run", async () => {
    fake.live = [{ filename: BUNDLE }];
    const result = await upload(contentFolder(), { dryRun: true });
    expect(fake.calls).toEqual(["GET …"]);
    expect(received.size).toBe(0);
    expect(result).toMatchObject({ dryRun: true, uploaded: 0, reused: 1, fileCount: 3 });
  });

  it("uploads in batches of 250", async () => {
    const dir = tempDir("susaplay-content-");
    const names = Array.from({ length: 300 }, (_, index) => `remote_${index}_${index.toString(16).padStart(32, "0")}.bundle`);
    writeFileSync(join(dir, "catalog_1.bin"), writeCatalog(names.map((name) => `${BASE}${name}`)));
    writeFileSync(join(dir, "catalog_1.hash"), "h");
    for (const name of names) writeFileSync(join(dir, name), "b");
    const result = await upload(dir);
    expect(fake.calls.filter((call) => call.endsWith("upload-batch"))).toHaveLength(2);
    expect(fake.calls.filter((call) => call.endsWith("register-batch"))).toHaveLength(2);
    expect(result.uploaded).toBe(302);
  });
});
