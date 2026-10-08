import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import type { ApiClient } from "../api/client.js";
import { fail, ok } from "./result.js";
import { gameIdSchema, num, str } from "./shared.js";

interface ApiFile {
  filename?: string;
  fileType?: string;
  sizeBytes?: number;
}

export interface ApiRelease {
  releaseNumber?: number;
  createdAt?: string | null;
  via?: string | null;
  catalogVersion?: string | null;
  fileCount?: number | null;
  totalSizeBytes?: number | null;
  liveBuildAtPublish?: string | null;
  compatibility?: { compatible?: boolean; checkedAgainst?: string | null; overridden?: boolean } | null;
  live?: boolean;
}

export interface ApiAddressables {
  enabled?: boolean;
  status?: string | null;
  remoteLoadPath?: string;
  liveCatalogVersion?: string | null;
  liveFileCount?: number | null;
  livePublishedAt?: string | null;
  liveReleaseId?: string | null;
  liveRolledBackFrom?: string | null;
  operationInProgress?: boolean;
  releases?: ApiRelease[];
  staging?: ApiFile[];
  live?: ApiFile[];
  stagingReadiness?: {
    hasCatalogHash?: boolean;
    hasCatalogBin?: boolean;
    bundleCount?: number;
    catalogVersion?: string | null;
    catalogPairMatched?: boolean;
    readyToPublish?: boolean;
  };
}

const sideSchema = z.object({ fileCount: z.number(), totalBytes: z.number() });

const releaseSchema = z.object({
  releaseNumber: z.number(),
  live: z.boolean(),
  createdAt: z.string().nullable(),
  catalogVersion: z.string().nullable(),
  fileCount: z.number().nullable(),
  totalBytes: z.number().nullable(),
  liveBuildAtPublish: z.string().nullable(),
  compatibilityOverridden: z.boolean(),
});

function summarizeRelease(release: ApiRelease): z.infer<typeof releaseSchema> | null {
  const releaseNumber = num(release.releaseNumber);
  if (releaseNumber === null) return null;
  return {
    releaseNumber,
    live: Boolean(release.live),
    createdAt: str(release.createdAt),
    catalogVersion: str(release.catalogVersion),
    fileCount: num(release.fileCount),
    totalBytes: num(release.totalSizeBytes),
    liveBuildAtPublish: str(release.liveBuildAtPublish),
    compatibilityOverridden: Boolean(release.compatibility?.overridden),
  };
}

const totals = (files: ApiFile[] = []) => ({
  fileCount: files.length,
  totalBytes: files.reduce((sum, file) => sum + (num(file.sizeBytes) ?? 0), 0),
});

/** What is missing before staging can be published, in the order a developer fixes it. */
function missingForPublish(readiness: NonNullable<ApiAddressables["stagingReadiness"]>): string[] {
  const missing: string[] = [];
  if (!readiness.hasCatalogBin) missing.push("the binary catalog (catalog_<version>.bin)");
  if (!readiness.hasCatalogHash) missing.push("the catalog hash (catalog_<version>.hash)");
  if (readiness.hasCatalogBin && readiness.hasCatalogHash && !readiness.catalogPairMatched) {
    missing.push("a .bin and .hash with the same catalog version");
  }
  if (!readiness.bundleCount) missing.push("at least one .bundle file");
  return missing;
}

export function registerAddressablesTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "get_addressables",
    {
      title: "Get a game's Addressables state",
      description:
        "Remote content (Unity Addressables) for one game: whether it is enabled and its status, the Remote " +
        "Load Path the Unity project must use, what is live (catalog version, files, size, when), what is " +
        "in staging with anything missing before it can be published, and the retained releases that " +
        "rollback_addressables can restore, with liveReleaseId to pass to it as expectedLiveReleaseId.",
      inputSchema: z.object({ gameId: gameIdSchema }),
      outputSchema: z.object({
        gameId: z.string(),
        enabled: z.boolean(),
        status: z.string().nullable(),
        remoteLoadPath: z.string().nullable(),
        liveReleaseId: z.string().nullable(),
        liveRolledBackFrom: z.string().nullable(),
        operationInProgress: z.boolean(),
        releases: z.array(releaseSchema),
        live: sideSchema.extend({ catalogVersion: z.string().nullable(), publishedAt: z.string().nullable() }),
        staging: sideSchema.extend({
          catalogVersion: z.string().nullable(),
          bundleCount: z.number(),
          readyToPublish: z.boolean(),
          missing: z.array(z.string()),
        }),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ gameId }) => {
      try {
        const data = await api.get<ApiAddressables>(`/catalog/game/${encodeURIComponent(gameId)}/addressables`);
        const readiness = data.stagingReadiness ?? {};
        const result = {
          gameId,
          enabled: Boolean(data.enabled),
          status: str(data.status),
          remoteLoadPath: str(data.remoteLoadPath),
          liveReleaseId: str(data.liveReleaseId),
          liveRolledBackFrom: str(data.liveRolledBackFrom),
          operationInProgress: Boolean(data.operationInProgress),
          releases: (data.releases ?? []).map(summarizeRelease).filter((release) => release !== null),
          live: {
            ...totals(data.live),
            catalogVersion: str(data.liveCatalogVersion),
            publishedAt: str(data.livePublishedAt),
          },
          staging: {
            ...totals(data.staging),
            catalogVersion: str(readiness.catalogVersion),
            bundleCount: num(readiness.bundleCount) ?? 0,
            readyToPublish: Boolean(readiness.readyToPublish),
            missing: (data.staging ?? []).length ? missingForPublish(readiness) : [],
          },
        };

        if (!result.enabled) {
          return ok(
            `Addressables are not enabled for ${gameId}. Enable them in the Developer Portal on the game's Addressables tab.`,
            result,
          );
        }
        const lines = [
          `Addressables ${result.status ?? "enabled"}. Remote Load Path: ${result.remoteLoadPath ?? "unknown"}`,
          result.live.fileCount
            ? `Live: catalog ${result.live.catalogVersion ?? "?"}, ${result.live.fileCount} files, published ${result.live.publishedAt ?? "at an unknown time"}.`
            : "Nothing live yet.",
          result.staging.fileCount
            ? `Staging: ${result.staging.fileCount} files, ${result.staging.readyToPublish ? "ready to publish" : `not ready — missing ${result.staging.missing.join("; ")}`}.`
            : "Staging is empty.",
          ...(result.releases.length
            ? [
                "Releases (newest first; the three newest and the live one are kept):",
                ...result.releases.map(
                  (release) =>
                    `- ${release.releaseNumber}${release.live ? " (live)" : ""}: catalog ${release.catalogVersion ?? "?"}, ` +
                    `${release.fileCount ?? "?"} files, ${release.createdAt ?? "unknown date"}` +
                    (release.liveBuildAtPublish ? `, build ${release.liveBuildAtPublish} was live` : ""),
                ),
              ]
            : []),
          ...(result.liveRolledBackFrom ? [`Live was rolled back from release ${result.liveRolledBackFrom}.`] : []),
          ...(result.operationInProgress ? ["A publish or rollback is running now."] : []),
        ];
        return ok(lines.join("\n"), result);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
