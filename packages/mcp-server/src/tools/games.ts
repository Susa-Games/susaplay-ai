import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import type { ApiClient } from "../api/client.js";
import { cleanText } from "../text.js";
import { fail, ok } from "./result.js";
import {
  type ApiGame,
  describeGame,
  gameIdSchema,
  gameSummarySchema,
  num,
  str,
  summarizeGame,
} from "./shared.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export interface ApiVersion {
  versionId: string;
  platform?: string;
  status?: string;
  uploadedAt?: string;
  buildSize?: number;
  notes?: string;
  reviewedAt?: string | null;
  liveAt?: string | null;
  rejectionReason?: string | null;
  failure?: { code?: string; message?: string } | null;
}

export interface RetentionPolicy {
  maxVersionsPerPlatform: number;
  minAgeHours: number;
  maxPendingPerGame: number;
}

const versionSchema = z.object({
  versionId: z.string(),
  status: z.string().nullable(),
  uploadedAt: z.string().nullable(),
  buildSizeBytes: z.number().nullable(),
  notes: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  liveAt: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  failure: z.object({ code: z.string().nullable(), message: z.string().nullable() }).nullable(),
});

const KEPT_STATUSES = new Set(["live", "pending_review", "processing", "extracting"]);

/**
 * Which WebGL builds the next successful upload deletes, as the server's
 * retention decides (build_retention.py): failed builds always; then, counting
 * the new build, everything past the newest `maxVersionsPerPlatform` that is not
 * live, in review, processing, or inside the grace period.
 */
export function retentionForecast(
  versions: ApiVersion[],
  policy: RetentionPolicy,
  liveVersionId: string | null,
  now: number = Date.now(),
): { deletedByNextUpload: string[]; protectedByGracePeriod: Array<{ versionId: string; deletableFrom: string }> } {
  const webgl = versions
    .filter((version) => (version.platform ?? "webgl") === "webgl")
    .sort((a, b) => Date.parse(b.uploadedAt ?? "") - Date.parse(a.uploadedAt ?? "") || 0);
  const deleted = webgl.filter((version) => version.status === "failed").map((version) => version.versionId);
  const grace: Array<{ versionId: string; deletableFrom: string }> = [];
  const graceMs = policy.minAgeHours * 3600 * 1000;
  // The new build takes one of the kept places.
  for (const version of webgl.filter((entry) => entry.status !== "failed").slice(Math.max(0, policy.maxVersionsPerPlatform - 1))) {
    if (KEPT_STATUSES.has(version.status ?? "") || version.versionId === liveVersionId) continue;
    const uploadedAt = Date.parse(version.uploadedAt ?? "");
    if (Number.isFinite(uploadedAt) && now - uploadedAt < graceMs) {
      grace.push({ versionId: version.versionId, deletableFrom: new Date(uploadedAt + graceMs).toISOString() });
      continue;
    }
    deleted.push(version.versionId);
  }
  return { deletedByNextUpload: deleted, protectedByGracePeriod: grace };
}

export function registerGameTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "list_games",
    {
      title: "List SusaPlay games",
      description:
        "Lists the developer's SusaPlay games: name, ID, what is live, the latest build and its status, builds " +
        "in review or processing, Addressables state, and the game key (matched against a Unity project's " +
        "PlatformConfig). Start here to find a game's ID.",
      inputSchema: z.object({}),
      outputSchema: z.object({ games: z.array(gameSummarySchema) }),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const data = await api.get<{ games: ApiGame[] }>("/catalog/games");
        const games = (data.games ?? []).map(summarizeGame);
        const summary = games.length
          ? `${games.length} game${games.length === 1 ? "" : "s"}:\n${games.map((game) => `- ${describeGame(game)}`).join("\n")}`
          : "This developer has no games yet. Register one in the SusaPlay Developer Portal.";
        return ok(summary, { games });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_game",
    {
      title: "Get a SusaPlay game with its builds",
      description:
        "One game with every build: status (processing, extracting, failed, pending_review, live, deprecated, " +
        "rejected), upload time, size, notes, review time and any failure reason, plus the retention policy and " +
        "which builds the next upload will delete.",
      inputSchema: z.object({ gameId: gameIdSchema }),
      outputSchema: z.object({
        game: gameSummarySchema,
        versions: z.array(versionSchema),
        retention: z
          .object({
            maxVersionsPerPlatform: z.number(),
            minAgeHours: z.number(),
            maxPendingPerGame: z.number(),
            deletedByNextUpload: z.array(z.string()),
            protectedByGracePeriod: z.array(z.object({ versionId: z.string(), deletableFrom: z.string() })),
          })
          .nullable()
          .describe("null when the SusaPlay API does not report its retention policy"),
      }),
      annotations: READ_ONLY,
    },
    async ({ gameId }) => {
      try {
        const id = encodeURIComponent(gameId);
        const [gameData, versionData] = await Promise.all([
          api.get<{ game: ApiGame; retention?: RetentionPolicy }>(`/catalog/game/${id}`),
          api.get<{ versions: ApiVersion[] }>(`/catalog/game/${id}/versions`),
        ]);
        const game = summarizeGame(gameData.game);
        const apiVersions = (versionData.versions ?? []).filter((version) => (version.platform ?? "webgl") === "webgl");
        const versions = apiVersions.map((version) => ({
          versionId: version.versionId,
          status: str(version.status),
          uploadedAt: str(version.uploadedAt),
          buildSizeBytes: num(version.buildSize),
          notes: cleanText(version.notes, 300),
          reviewedAt: str(version.reviewedAt),
          liveAt: str(version.liveAt),
          rejectionReason: cleanText(version.rejectionReason, 300),
          failure: version.failure
            ? { code: str(version.failure.code), message: cleanText(version.failure.message, 300) }
            : null,
        }));
        // An API from before the policy was returned with the game has none to forecast with.
        const policy = gameData.retention ?? null;
        const forecast = policy ? retentionForecast(apiVersions, policy, game.liveVersionId) : null;

        const lines = [describeGame(game)];
        for (const version of versions) {
          const reason = version.failure?.message ?? version.rejectionReason;
          lines.push(`- ${version.versionId}: ${version.status ?? "unknown"}${reason ? ` — ${reason}` : ""}`);
        }
        if (policy && forecast) {
          lines.push(
            `Retention keeps ${policy.maxVersionsPerPlatform} builds, at most ${policy.maxPendingPerGame} in review. ` +
              (forecast.deletedByNextUpload.length
                ? `The next upload deletes: ${forecast.deletedByNextUpload.join(", ")}.`
                : "The next upload deletes nothing."),
          );
        }
        return ok(lines.join("\n"), {
          game,
          versions,
          retention: policy && forecast ? { ...policy, ...forecast } : null,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
