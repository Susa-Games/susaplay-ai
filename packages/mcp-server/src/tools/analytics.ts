import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import type { ApiClient } from "../api/client.js";
import { fail, ok } from "./result.js";
import { gameIdSchema, num } from "./shared.js";

interface ApiAnalytics {
  gameId: string;
  days: number;
  dates: string[];
  dau: number[];
  mau: number[];
  retention: { d1?: number; d7?: number; d30?: number } | null;
}

const percent = (value: number | null) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);

export function registerAnalyticsTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "get_analytics",
    {
      title: "Get a game's player activity",
      description:
        "Daily active players (DAU), 30-day active players (MAU) and the latest D1/D7/D30 retention for one game " +
        "over the last 1–90 days. Revenue is deliberately not included: money figures come from the Developer " +
        "Portal's payment reports, not from analytics. Empty numbers are normal for a game built with a SusaPlay " +
        "SDK older than 1.3.0.",
      inputSchema: z.object({
        gameId: gameIdSchema.optional().describe("The game's ID; may be left out when the developer has one game"),
        days: z.number().int().min(1).max(90).default(30).describe("How many days back, 1–90"),
      }),
      outputSchema: z.object({
        gameId: z.string(),
        days: z.number(),
        dates: z.array(z.string()),
        dau: z.array(z.number()),
        mau: z.array(z.number()),
        retention: z.object({ d1: z.number().nullable(), d7: z.number().nullable(), d30: z.number().nullable() }).nullable(),
        activeDays: z.number(),
        peakDau: z.number(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ gameId, days }) => {
      try {
        const data = await api.get<ApiAnalytics>("/analytics/dashboard", { gameId, days });
        const dau = (data.dau ?? []).map((value) => num(value) ?? 0);
        const retention = data.retention
          ? { d1: num(data.retention.d1), d7: num(data.retention.d7), d30: num(data.retention.d30) }
          : null;
        const result = {
          gameId: data.gameId,
          days: data.days,
          dates: data.dates ?? [],
          dau,
          mau: (data.mau ?? []).map((value) => num(value) ?? 0),
          retention,
          activeDays: dau.filter((value) => value > 0).length,
          peakDau: dau.length ? Math.max(...dau) : 0,
        };
        const summary = result.activeDays
          ? `${result.gameId}, last ${result.days} days: players on ${result.activeDays} days, peak DAU ${result.peakDau}` +
            (retention ? `; latest retention D1 ${percent(retention.d1)}, D7 ${percent(retention.d7)}, D30 ${percent(retention.d30)}.` : ".")
          : `${result.gameId}: no player activity recorded in the last ${result.days} days.`;
        return ok(summary, result);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
