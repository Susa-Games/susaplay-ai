import * as z from "zod";

import { cleanText } from "../text.js";

export const gameIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, "A game ID is letters, digits, '-' and '_' — use list_games to find it")
  .describe("The game's ID, from list_games");

export const addressablesSummarySchema = z.object({
  enabled: z.boolean(),
  status: z.string().nullable(),
  liveCatalogVersion: z.string().nullable(),
  liveFileCount: z.number().nullable(),
  livePublishedAt: z.string().nullable(),
});

export const gameSummarySchema = z.object({
  name: z.string(),
  gameId: z.string(),
  status: z.string().nullable(),
  releaseState: z.string().nullable(),
  gameKey: z.string().nullable(),
  liveVersionId: z.string().nullable(),
  latestVersion: z
    .object({ versionId: z.string(), status: z.string().nullable(), uploadedAt: z.string().nullable() })
    .nullable(),
  pendingReviewCount: z.number(),
  processingCount: z.number(),
  versionCount: z.number(),
  addressables: addressablesSummarySchema,
});
export type GameSummary = z.infer<typeof gameSummarySchema>;

/** The API's game entry (GET /catalog/games and /catalog/game/{id}). */
export interface ApiGame {
  gameId: string;
  name?: string;
  status?: string;
  releaseState?: string;
  gameKey?: string;
  liveWebglVersionId?: string | null;
  latestVersion?: { versionId: string; status?: string; uploadedAt?: string } | null;
  buildSummary?: { pendingReviewCount?: number; processingCount?: number; versionCount?: number };
  addressables?: {
    enabled?: boolean;
    status?: string | null;
    liveCatalogVersion?: string | null;
    liveFileCount?: number | null;
    livePublishedAt?: string | null;
  };
}

export const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
export const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function summarizeGame(game: ApiGame): GameSummary {
  const latest = game.latestVersion;
  return {
    name: cleanText(game.name, 120) ?? game.gameId,
    gameId: game.gameId,
    status: str(game.status),
    releaseState: str(game.releaseState),
    gameKey: str(game.gameKey),
    liveVersionId: str(game.liveWebglVersionId),
    latestVersion: latest
      ? { versionId: latest.versionId, status: str(latest.status), uploadedAt: str(latest.uploadedAt) }
      : null,
    pendingReviewCount: game.buildSummary?.pendingReviewCount ?? 0,
    processingCount: game.buildSummary?.processingCount ?? 0,
    versionCount: game.buildSummary?.versionCount ?? 0,
    addressables: {
      enabled: Boolean(game.addressables?.enabled),
      status: str(game.addressables?.status),
      liveCatalogVersion: str(game.addressables?.liveCatalogVersion),
      liveFileCount: num(game.addressables?.liveFileCount),
      livePublishedAt: str(game.addressables?.livePublishedAt),
    },
  };
}

export function describeGame(game: GameSummary): string {
  const parts = [`${game.name} (${game.gameId})`];
  parts.push(game.liveVersionId ? `live ${game.liveVersionId}` : "nothing live");
  if (game.latestVersion && game.latestVersion.versionId !== game.liveVersionId) {
    parts.push(`latest ${game.latestVersion.versionId} ${game.latestVersion.status ?? ""}`.trim());
  }
  if (game.pendingReviewCount) parts.push(`${game.pendingReviewCount} in review`);
  if (game.processingCount) parts.push(`${game.processingCount} processing`);
  parts.push(game.addressables.enabled ? `Addressables ${game.addressables.status ?? "enabled"}` : "no Addressables");
  return parts.join(", ");
}
