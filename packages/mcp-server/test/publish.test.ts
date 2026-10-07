import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ApiClient } from "../src/api/client.js";
import { ToolInputError } from "../src/tools/result.js";
import { nextPatchVersion, playerPortalBase, publishBuild } from "../src/tools/publish.js";
import { ZipArchive } from "../src/unity/archive.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/unity6-addressables/", import.meta.url));
const BUILD = join(FIXTURE, "build");
const SERVER_DATA = join(FIXTURE, "serverData");
const GAME = "test-game";

// Storage: keeps each upload; `dropNext` closes the connection once, as a network failure would.
let storage: Server;
let storageUrl: string;
let uploads: Buffer[] = [];
let dropNext = false;
const scratch = mkdtempSync(join(tmpdir(), "susaplay-publish-"));

beforeAll(async () => {
  storage = createServer((request, response) => {
    if (dropNext) {
      dropNext = false;
      request.socket.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      uploads.push(Buffer.concat(chunks));
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise<void>((resolve) => storage.listen(0, "127.0.0.1", resolve));
  storageUrl = `http://127.0.0.1:${(storage.address() as AddressInfo).port}`;
});

afterAll(() => {
  storage.close();
  rmSync(scratch, { recursive: true, force: true });
});

interface FakeApi {
  versionsBefore: Array<Record<string, unknown>>;
  versionsAfter: Array<Record<string, unknown>>;
  polls: Array<Record<string, unknown>>;
  calls: string[];
  bodies: Record<string, unknown>;
  uploadUrl?: string;
}

let fake: FakeApi;

beforeEach(() => {
  uploads = [];
  dropNext = false;
  fake = {
    versionsBefore: [
      { versionId: "1.0.2", platform: "webgl", status: "live", uploadedAt: "2026-09-01T00:00:00+00:00" },
      { versionId: "1.0.0", platform: "webgl", status: "rejected", uploadedAt: "2026-08-01T00:00:00+00:00" },
    ],
    versionsAfter: [
      { versionId: "1.0.3", platform: "webgl", status: "pending_review" },
      { versionId: "1.0.2", platform: "webgl", status: "live" },
    ],
    polls: [{ versionId: "1.0.3", status: "extracting" }, { versionId: "1.0.3", status: "pending_review" }],
    calls: [],
    bodies: {},
  };
});

function client(): ApiClient {
  let listed = 0;
  const fetch = async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.test", "");
    fake.calls.push(`${init.method} ${path}`);
    if (init.body) fake.bodies[path] = JSON.parse(String(init.body));
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
    if (path === `/catalog/game/${GAME}`) {
      return reply({ game: { gameId: GAME }, retention: { maxVersionsPerPlatform: 2, minAgeHours: 24, maxPendingPerGame: 3 } });
    }
    if (path === `/catalog/game/${GAME}/versions`) {
      listed += 1;
      return reply({ versions: listed === 1 ? fake.versionsBefore : fake.versionsAfter });
    }
    if (path === "/catalog/get-upload-url") return reply({ uploadUrl: fake.uploadUrl ?? `${storageUrl}/signed` });
    if (path === "/catalog/process-build") return reply({ versionId: "1.0.3", status: "processing" }, 202);
    if (path === `/catalog/game/${GAME}/versions/1.0.3`) return reply({ version: fake.polls.shift() });
    return new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "no route" } }), { status: 404 });
  };
  return new ApiClient({ apiKey: "spdk_test", apiBaseUrl: "https://api.test" }, { fetch, sleep: async () => undefined });
}

async function publish(overrides: Partial<{ gameId: string; versionId: string; buildPath: string }> = {}) {
  const sleeps: number[] = [];
  const result = await publishBuild(
    { gameId: GAME, versionId: "1.0.3", buildPath: BUILD, serverDataPath: SERVER_DATA, notes: "new level", ...overrides },
    { api: client(), sleep: async (ms) => void sleeps.push(ms) },
  );
  return { result, sleeps };
}

describe("publishBuild", () => {
  it("zips the folder, uploads it, processes it and reports what retention deleted", async () => {
    const tempBefore = readdirSync(tmpdir()).filter((name) => name.startsWith("susaplay-build-zip-"));
    const { result, sleeps } = await publish();

    expect(result).toMatchObject({ gameId: GAME, versionId: "1.0.3", status: "pending_review", failure: null, prunedVersions: ["1.0.0"] });
    expect(result.nextStep).toContain("create_preview_link");
    expect(sleeps).toEqual([2000, 3000]);
    expect(fake.calls).toEqual([
      `GET /catalog/game/${GAME}`,
      `GET /catalog/game/${GAME}/versions`,
      "POST /catalog/get-upload-url",
      "POST /catalog/process-build",
      `GET /catalog/game/${GAME}/versions/1.0.3`,
      `GET /catalog/game/${GAME}/versions/1.0.3`,
      `GET /catalog/game/${GAME}/versions`,
    ]);
    expect(fake.bodies["/catalog/process-build"]).toEqual({ gameId: GAME, versionId: "1.0.3", platform: "webgl", notes: "new level" });

    // What Storage received is the build, at the zip's root.
    expect(uploads).toHaveLength(1);
    writeFileSync(join(scratch, "received.zip"), uploads[0]!);
    const archive = await ZipArchive.open(join(scratch, "received.zip"));
    const names = archive.entries.map((entry) => entry.name);
    await archive.close();
    expect(names).toContain("index.html");
    expect(names).toContain("Build/WebGL.loader.js");
    expect(names).toContain("StreamingAssets/aa/catalog.bin");
    expect(result.fileCount).toBe(names.length);
    expect(result.zipBytes).toBe(uploads[0]!.length);

    // The temporary zip is gone.
    const tempAfter = readdirSync(tmpdir()).filter((name) => name.startsWith("susaplay-build-zip-"));
    expect(tempAfter.sort()).toEqual(tempBefore.sort());
  });

  it("retries once with a fresh URL after a network failure", async () => {
    dropNext = true;
    const { result } = await publish();
    expect(result.status).toBe("pending_review");
    expect(fake.calls.filter((call) => call === "POST /catalog/get-upload-url")).toHaveLength(2);
    expect(uploads).toHaveLength(1);
  });

  it("stops on an inspection error before anything is sent", async () => {
    const error = await publish({ gameId: "another-game" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ToolInputError);
    expect(error.message).toContain("B010");
    expect(fake.calls.some((call) => call.startsWith("POST"))).toBe(false);
  });

  it("refuses an existing version before zipping, and suggests the next one", async () => {
    const error = await publish({ versionId: "1.0.2" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ToolInputError);
    expect(error.message).toBe("Version 1.0.2 already exists (live). Use 1.0.3.");
    expect(uploads).toHaveLength(0);
  });

  it("refuses when the review queue is full, naming the builds in it", async () => {
    fake.versionsBefore = ["1.0.4", "1.0.5", "1.0.6"].map((versionId) => ({ versionId, status: "pending_review" }));
    const error = await publish({ versionId: "1.0.7" }).catch((caught) => caught);
    expect(error.message).toContain("1.0.4 (pending_review), 1.0.5 (pending_review), 1.0.6 (pending_review)");
    expect(uploads).toHaveLength(0);
  });

  it("reports a build that failed processing", async () => {
    fake.polls = [{ versionId: "1.0.3", status: "failed", failure: { code: "INVALID_ARGUMENT", message: "Build must contain index.html at root" } }];
    const { result } = await publish();
    expect(result).toMatchObject({ status: "failed", prunedVersions: [] });
    expect(result.nextStep).toContain("Build must contain index.html at root");
  });

  it("never sends a build to a host other than Cloud Storage", async () => {
    fake.uploadUrl = "https://example.com/upload";
    const error = await publish().catch((caught) => caught);
    expect(error.code).toBe("SIGNED_URL_UNAVAILABLE");
    expect(fake.calls).not.toContain("POST /catalog/process-build");
  });
});

describe("helpers", () => {
  it("suggests the patch after the highest version", () => {
    expect(nextPatchVersion(["1.0.8", "1.0.10", "0.9.99", "1.0.9-beta"])).toBe("1.0.11");
    expect(nextPatchVersion([])).toBeNull();
  });

  it("opens previews on the player site of the API's environment", () => {
    expect(playerPortalBase("https://api.susaplay.com")).toBe("https://susaplay.com");
    expect(playerPortalBase("https://europe-west1-susaplaytest.cloudfunctions.net")).toBe("https://susaplay-player-staging.web.app");
  });
});
