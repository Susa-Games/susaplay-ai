import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/errors.js";
import { type BuildSource, openBuild } from "../unity/build-source.js";
import { type CatalogBundle, CatalogFormatError, readCatalogBundles } from "../unity/catalog.js";
import type { Finding } from "./check-project.js";
import { ToolInputError, fail, ok } from "./result.js";
import { gameIdSchema } from "./shared.js";

// The server's limits (build_storage.py).
const MAX_ENTRIES = 1000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1500 * 1024 * 1024;
export const MAX_ZIP_BYTES = 500 * 1024 * 1024;
const ADDRESSABLES_BASE = "https://games.susaplay.com/addressables/";
const REMOTE_HASH_KEY = "AddressablesMainContentCatalogRemoteHash";
const MAX_LISTED = 10;

const MB = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
const listed = (names: string[]) =>
  names.slice(0, MAX_LISTED).join(", ") + (names.length > MAX_LISTED ? ` and ${names.length - MAX_LISTED} more` : "");

export interface BuildReport {
  passed: boolean;
  kind: "zip" | "folder";
  fileCount: number;
  zippedBytes: number | null;
  uncompressedBytes: number;
  remoteCatalogUrl: string | null;
  catalogChecked: "serverData" | "live" | "build" | null;
  findings: Finding[];
}

/** The URL of the remote catalog's .hash the player requests, from StreamingAssets/aa/settings.json. */
function remoteCatalogHashUrl(settings: unknown): string | null {
  const locations = (settings as { m_CatalogLocations?: Array<{ m_Keys?: string[]; m_InternalId?: string }> })?.m_CatalogLocations;
  const remote = locations?.find((location) => location.m_Keys?.includes(REMOTE_HASH_KEY));
  return typeof remote?.m_InternalId === "string" ? remote.m_InternalId : null;
}

interface Candidate {
  source: "serverData" | "live" | "build";
  bundles: CatalogBundle[];
  /** Bundle files available remotely; `null` when that is not known. */
  remoteFiles: Set<string> | null;
}

async function serverDataCandidate(dir: string, catalogName: string | null, add: (finding: Finding) => void): Promise<Candidate | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    throw new ToolInputError(`serverDataPath ${dir} is not a folder. Pass the Addressables build output, such as ServerData/WebGL.`);
  }
  const catalogs = names.filter((name) => /^catalog_.+\.bin$/.test(name));
  const wanted = catalogName ?? (catalogs.length === 1 ? catalogs[0] : null);
  if (catalogName && !names.includes(catalogName)) {
    add({
      id: "B011",
      severity: "error",
      message: `The build requests ${catalogName}, but ${dir} has ${catalogs.length ? catalogs.join(", ") : "no binary catalog"}. Players of this build would never see this content: check the Player Version Override (SP013).`,
    });
    return null;
  }
  if (catalogName && !names.includes(catalogName.replace(/\.bin$/, ".hash"))) {
    add({ id: "B011", severity: "error", message: `${catalogName.replace(/\.bin$/, ".hash")} is missing next to ${catalogName}.` });
  }
  if (!wanted) {
    add({ id: "B015", severity: "error", message: `No single binary catalog (catalog_*.bin) in ${dir} to check.` });
    return null;
  }
  return {
    source: "serverData",
    bundles: readCatalogBundles(await readFile(join(dir, wanted))),
    remoteFiles: new Set(names.filter((name) => name.endsWith(".bundle"))),
  };
}

async function liveCandidate(
  gameId: string,
  hashUrl: string,
  api: ApiClient,
  fetchImpl: typeof fetch,
  add: (finding: Finding) => void,
): Promise<Candidate | null> {
  const base = `${ADDRESSABLES_BASE}${gameId}/`;
  // Only this game's public catalog is ever fetched: a URL read out of a build
  // file must not make the tool request anything else.
  if (!hashUrl.startsWith(base) || !/^catalog_[^/]+\.hash$/.test(hashUrl.slice(base.length))) return null;
  const response = await fetchImpl(hashUrl.replace(/\.hash$/, ".bin"), { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) {
    add({ id: "B011", severity: "error", message: `Nothing is published at ${hashUrl.replace(/\.hash$/, ".bin")}: this build would find no remote content.` });
    return null;
  }
  if (!response.ok) throw new ApiError("NETWORK", `the live catalog answered ${response.status}`, response.status);
  const bundles = readCatalogBundles(new Uint8Array(await response.arrayBuffer()));
  let remoteFiles: Set<string> | null = null;
  if (api.hasKey) {
    const live = await api.get<{ live?: Array<{ filename?: string }> }>(`/catalog/game/${encodeURIComponent(gameId)}/addressables`);
    remoteFiles = new Set((live.live ?? []).map((file) => file.filename ?? "").filter(Boolean));
  } else {
    add({ id: "B016", severity: "info", message: "Remote bundles were not checked against the live files: no SusaPlay API key is set." });
  }
  return { source: "live", bundles, remoteFiles };
}

export async function inspectBuild(
  build: BuildSource,
  options: { gameId?: string; serverDataPath?: string; api: ApiClient; fetch?: typeof fetch },
): Promise<BuildReport> {
  const findings: Finding[] = [];
  const add = (finding: Finding) => findings.push(finding);
  const uncompressedBytes = [...build.files.values()].reduce((sum, size) => sum + size, 0);

  // The server's rules, so a build that would be refused is caught before the upload.
  if (!build.files.has("index.html") || !build.originalNames.some((name) => name.endsWith(".loader.js"))) {
    add({ id: "B001", severity: "error", message: "The build needs index.html at its root and a *.loader.js file. Zip the WebGL build output folder itself, not a folder of builds." });
  }
  if (build.entryCount > MAX_ENTRIES) {
    add({ id: "B002", severity: "error", message: `The build has ${build.entryCount} entries; at most ${MAX_ENTRIES} are accepted.` });
  }
  const oversized = [...build.files].filter(([, size]) => size > MAX_FILE_BYTES).map(([name]) => name);
  if (oversized.length) add({ id: "B003", severity: "error", message: `Over the 200 MB per-file limit: ${listed(oversized)}.` });
  if (uncompressedBytes > MAX_TOTAL_BYTES) add({ id: "B004", severity: "error", message: `The build is ${MB(uncompressedBytes)} uncompressed; the limit is 1.5 GB.` });
  if (build.zippedBytes !== null && build.zippedBytes > MAX_ZIP_BYTES) {
    add({ id: "B005", severity: "error", message: `The zip is ${MB(build.zippedBytes)}; the limit is 500 MB.` });
  }
  const archives = [...build.files.keys()].filter((name) => /\.(zip|rar|7z)$/i.test(name));
  if (archives.length) {
    add({
      id: "B007",
      severity: "warning",
      message: `The build contains archive files that would be uploaded and served with it: ${listed(archives)}. Remove them from the build folder.`,
    });
  }
  if (build.junk.length) {
    add({ id: "B006", severity: "info", message: `${build.junk.length} operating-system files are skipped by SusaPlay: ${listed(build.junk)}.` });
  }

  // Addressables: the remote catalog the player will request, and the bundles behind it.
  const settingsBytes = await build.read("StreamingAssets/aa/settings.json");
  let remoteCatalogUrl: string | null = null;
  let catalogChecked: BuildReport["catalogChecked"] = null;
  if (settingsBytes) {
    try {
      remoteCatalogUrl = remoteCatalogHashUrl(JSON.parse(settingsBytes.toString("utf8")));
    } catch {
      add({ id: "B015", severity: "error", message: "StreamingAssets/aa/settings.json could not be read." });
    }
    const expectedBase = options.gameId ? `${ADDRESSABLES_BASE}${options.gameId}/` : ADDRESSABLES_BASE;
    if (remoteCatalogUrl && !remoteCatalogUrl.startsWith(expectedBase)) {
      add({ id: "B010", severity: "error", message: `The build requests its remote catalog from ${remoteCatalogUrl}; it must come from ${options.gameId ? expectedBase : `${ADDRESSABLES_BASE}<gameId>/`}. Fix the Remote Load Path (SP010) and rebuild.` });
    }
    if (!remoteCatalogUrl) {
      add({ id: "B017", severity: "info", message: "The build requests no remote catalog: Addressables content published later never reaches it." });
    }

    const localBundles = new Set(
      [...build.files.keys()].filter((name) => name.startsWith("StreamingAssets/aa/WebGL/") && name.endsWith(".bundle")).map((name) => name.slice(name.lastIndexOf("/") + 1)),
    );
    const catalogName = remoteCatalogUrl ? remoteCatalogUrl.slice(remoteCatalogUrl.lastIndexOf("/") + 1).replace(/\.hash$/, ".bin") : null;
    let candidate: Candidate | null = null;
    try {
      if (options.serverDataPath) {
        candidate = await serverDataCandidate(options.serverDataPath, catalogName, add);
      } else if (options.gameId && remoteCatalogUrl) {
        candidate = await liveCandidate(options.gameId, remoteCatalogUrl, options.api, options.fetch ?? fetch, add);
      } else {
        const own = await build.read("StreamingAssets/aa/catalog.bin");
        candidate = own ? { source: "build", bundles: readCatalogBundles(own), remoteFiles: null } : null;
      }
    } catch (error) {
      if (!(error instanceof CatalogFormatError)) throw error;
      add({ id: "B015", severity: "error", message: `The catalog could not be read: ${error.message}. It may be JSON (refused, SP015) or from an unsupported Addressables version.` });
    }

    if (candidate) {
      catalogChecked = candidate.source;
      const against = candidate.source === "serverData" ? "the content in serverDataPath" : candidate.source === "live" ? "the live content" : "the build's own catalog";
      // The check that would have caught 2026-09-30: every local bundle the
      // catalog names must ship in this build.
      const missingLocal = candidate.bundles.filter((bundle) => bundle.local && !localBundles.has(bundle.fileName)).map((bundle) => bundle.fileName);
      if (missingLocal.length) {
        add({
          id: "B012",
          severity: "error",
          message: `${against[0]?.toUpperCase()}${against.slice(1)} expects ${missingLocal.length} bundle(s) inside the build that this build does not have — every player would hit a 404: ${listed(missingLocal)}. The content and the build come from different Addressables builds; build both together, or make the default group remote (SP012).`,
        });
      }
      if (candidate.remoteFiles) {
        const missingRemote = candidate.bundles.filter((bundle) => !bundle.local && !candidate!.remoteFiles!.has(bundle.fileName)).map((bundle) => bundle.fileName);
        if (missingRemote.length) {
          add({ id: "B013", severity: "error", message: `The catalog names remote bundles that ${against} does not have: ${listed(missingRemote)}.` });
        }
      }
      const gameBase = options.gameId ? `${ADDRESSABLES_BASE}${options.gameId}/` : null;
      const foreign = candidate.bundles.filter((bundle) => !bundle.local && !(gameBase ? bundle.internalId.startsWith(gameBase) : bundle.internalId.startsWith(ADDRESSABLES_BASE)));
      if (foreign.length) {
        add({ id: "B014", severity: "error", message: `Remote bundles load from outside ${gameBase ?? `${ADDRESSABLES_BASE}<gameId>/`}: ${listed(foreign.map((bundle) => bundle.internalId))}.` });
      }
    }
  }

  return {
    passed: !findings.some((finding) => finding.severity === "error"),
    kind: build.kind,
    fileCount: build.files.size,
    zippedBytes: build.zippedBytes,
    uncompressedBytes,
    remoteCatalogUrl,
    catalogChecked,
    findings,
  };
}

export function registerInspectBuildTool(
  server: McpServer,
  api: ApiClient,
  cwd: () => string = () => process.cwd(),
  fetchImpl?: typeof fetch,
): void {
  server.registerTool(
    "inspect_build",
    {
      title: "Inspect a WebGL build before uploading it",
      description:
        "Checks a Unity WebGL build — its folder or .zip — against SusaPlay's upload rules (index.html, loader, " +
        "file counts and sizes) so a build that would be refused is caught before a long upload. For " +
        "Addressables it checks that every bundle the catalog expects inside the build is there, comparing with " +
        "serverDataPath (content about to be published) or, with gameId, the live content.",
      inputSchema: z.object({
        buildPath: z.string().describe("The WebGL build output folder, or its .zip"),
        gameId: gameIdSchema.optional().describe("Compare with this game's live Addressables content"),
        serverDataPath: z.string().optional().describe("The Addressables build output to be published, such as ServerData/WebGL"),
      }),
      outputSchema: z.object({
        passed: z.boolean(),
        kind: z.enum(["zip", "folder"]),
        fileCount: z.number(),
        zippedBytes: z.number().nullable(),
        uncompressedBytes: z.number(),
        remoteCatalogUrl: z.string().nullable(),
        catalogChecked: z.enum(["serverData", "live", "build"]).nullable(),
        findings: z.array(z.object({ id: z.string(), severity: z.enum(["error", "warning", "info"]), message: z.string(), file: z.string().optional() })),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ buildPath, gameId, serverDataPath }) => {
      const absolute = (path: string) => (isAbsolute(path) ? path : resolve(cwd(), path));
      let build: BuildSource | null = null;
      try {
        build = await openBuild(absolute(buildPath));
        const report = await inspectBuild(build, {
          gameId,
          serverDataPath: serverDataPath ? absolute(serverDataPath) : undefined,
          api,
          fetch: fetchImpl,
        });
        const size = report.zippedBytes !== null ? `${MB(report.zippedBytes)} zipped` : `${MB(report.uncompressedBytes)} uncompressed`;
        const lines = [
          `${report.passed ? "Ready to upload" : "Not ready to upload"}: ${report.fileCount} files, ${size}.`,
          ...report.findings.map((finding) => `- ${finding.id} ${finding.severity}: ${finding.message}`),
        ];
        return ok(lines.join("\n"), { ...report });
      } catch (error) {
        return fail(error);
      } finally {
        await build?.close();
      }
    },
  );
}
