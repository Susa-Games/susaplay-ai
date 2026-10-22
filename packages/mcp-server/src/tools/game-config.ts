import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import type { ApiClient } from "../api/client.js";
import { ToolInputError, fail, ok } from "./result.js";
import { gameIdSchema, num } from "./shared.js";

interface ApiTier {
  priceTierId: string;
  amountMinor: number;
  currency: string;
}

interface ApiItem {
  name?: string;
  description?: string;
  priceTier?: string;
  type?: string;
  walletPurchaseEnabled?: boolean;
}

interface ApiAchievement {
  id: string;
  name?: string;
  type?: string;
  targetValue?: number | null;
  points?: number;
}

const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,120}$/, "Letters, digits, '.', '-' and '_' only")
  .describe("The ID the game's code will use — stable, never reused for something else");

const money = (tier: ApiTier) => `${(tier.amountMinor / 100).toFixed(2)} ${tier.currency}`;

export function registerGameConfigTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "get_game_config",
    {
      title: "Get a game's store items, achievements and price tiers",
      description:
        "The game's store items and achievement definitions as registered on SusaPlay, and the price tiers a new " +
        "item can use (with each tier's coin price). Read it before add_store_item or add_achievement, so an ID " +
        "is not reused and the price is a real tier. Changes nothing.",
      inputSchema: z.object({ gameId: gameIdSchema }),
      outputSchema: z.object({
        gameId: z.string(),
        items: z.array(
          z.object({
            itemId: z.string(),
            name: z.string(),
            type: z.string(),
            priceTier: z.string().nullable(),
            walletPurchaseEnabled: z.boolean(),
          }),
        ),
        achievements: z.array(
          z.object({ achievementId: z.string(), name: z.string(), type: z.string(), targetValue: z.number().nullable(), points: z.number() }),
        ),
        priceTiers: z.array(z.object({ priceTierId: z.string(), price: z.string(), coinPrice: z.number().nullable() })),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ gameId }) => {
      try {
        const id = encodeURIComponent(gameId);
        const [economy, achievementsData] = await Promise.all([
          api.get<{ items?: Record<string, ApiItem>; priceTiers?: ApiTier[]; coinsPerCent?: number }>(
            `/catalog/game/${id}/economy-config`,
          ),
          api.get<{ achievements?: ApiAchievement[] }>(`/catalog/game/${id}/achievements`),
        ]);
        const coinsPerCent = num(economy.coinsPerCent);
        const result = {
          gameId,
          items: Object.entries(economy.items ?? {}).map(([itemId, item]) => ({
            itemId,
            name: item.name ?? "",
            type: item.type ?? "durable",
            priceTier: item.priceTier ?? null,
            walletPurchaseEnabled: item.walletPurchaseEnabled === true,
          })),
          achievements: (achievementsData.achievements ?? []).map((achievement) => ({
            achievementId: achievement.id,
            name: achievement.name ?? "",
            type: achievement.type ?? "oneshot",
            targetValue: num(achievement.targetValue),
            points: num(achievement.points) ?? 0,
          })),
          priceTiers: (economy.priceTiers ?? []).map((tier) => ({
            priceTierId: tier.priceTierId,
            price: money(tier),
            coinPrice: coinsPerCent === null ? null : tier.amountMinor * coinsPerCent,
          })),
        };
        const lines = [
          `${gameId}: ${result.items.length} store items, ${result.achievements.length} achievements.`,
          result.priceTiers.length
            ? `Price tiers on sale: ${result.priceTiers.map((tier) => `${tier.priceTierId} (${tier.price})`).join(", ")}.`
            : "No price tier is on sale right now, so no item can be added.",
        ];
        return ok(lines.join("\n"), result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "add_store_item",
    {
      title: "Add a store item",
      description:
        "Registers a new store item on SusaPlay so the game can sell it with StartDirectItemPurchase (money) and, " +
        "if allowed, SpendPlatformWallet (coins). Create only: an existing ID is refused, and editing or deleting " +
        "an item stays in the Developer Portal. Before calling, show the developer the ID, name, type, price tier " +
        "and whether coins are allowed, and add it only after they confirm. walletPurchaseEnabled lets players pay " +
        "with SusaPlay coins, which earns the developer nothing: set it true only when the developer explicitly " +
        "confirmed that choice. Needs the game-config:write permission. Afterwards, run sync_simulator_config.",
      inputSchema: z.object({
        gameId: gameIdSchema,
        itemId: idSchema,
        name: z.string().min(1).max(100).describe("Shown to players"),
        description: z.string().max(500).optional(),
        type: z.enum(["durable", "consumable"]).describe("durable: owned forever; consumable: used up with ConsumeItem"),
        priceTier: z.string().min(1).describe("A priceTierId from get_game_config"),
        walletPurchaseEnabled: z
          .boolean()
          .default(false)
          .describe("Also sold for SusaPlay coins. Earns the developer nothing; only with the developer's explicit confirmation"),
      }),
      outputSchema: z.object({
        gameId: z.string(),
        itemId: z.string(),
        name: z.string(),
        type: z.string(),
        priceTier: z.string(),
        walletPurchaseEnabled: z.boolean(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ gameId, itemId, name, description, type, priceTier, walletPurchaseEnabled }) => {
      try {
        const data = await api.post<{ item?: ApiItem }>(`/catalog/game/${encodeURIComponent(gameId)}/economy/items`, {
          itemId,
          name,
          description: description ?? "",
          type,
          priceTier,
          walletPurchaseEnabled,
        });
        const item = data.item ?? {};
        const result = {
          gameId,
          itemId,
          name: item.name ?? name,
          type: item.type ?? type,
          priceTier: item.priceTier ?? priceTier,
          walletPurchaseEnabled: item.walletPurchaseEnabled === true,
        };
        return ok(
          `Added store item ${itemId} (${result.name}, ${result.type}, ${result.priceTier}` +
            `${result.walletPurchaseEnabled ? ", also for coins" : ""}). It appears in GetStoreItems now. ` +
            "Run sync_simulator_config so the Editor Simulator knows it.",
          result,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "add_achievement",
    {
      title: "Add an achievement",
      description:
        "Registers a new achievement on SusaPlay so the game can unlock it (Unlock for oneshot, Increment for " +
        "incremental). Create only: an existing ID is refused, and editing or deleting stays in the Developer " +
        "Portal. Points feed the player's platform level. Before calling, show the developer the ID, name, type, " +
        "target and points, and add it only after they confirm. Needs the game-config:write permission. " +
        "Afterwards, run sync_simulator_config.",
      inputSchema: z.object({
        gameId: gameIdSchema,
        achievementId: idSchema,
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        type: z.enum(["oneshot", "incremental"]),
        targetValue: z.number().int().min(1).optional().describe("Required for incremental: the count that unlocks it"),
        points: z.number().int().min(0).max(10_000).default(0),
      }),
      outputSchema: z.object({
        gameId: z.string(),
        achievementId: z.string(),
        type: z.string(),
        targetValue: z.number().nullable(),
        points: z.number(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ gameId, achievementId, name, description, type, targetValue, points }) => {
      try {
        if (type === "incremental" && targetValue === undefined) {
          throw new ToolInputError("An incremental achievement needs targetValue.");
        }
        await api.post(`/catalog/game/${encodeURIComponent(gameId)}/achievements/add`, {
          achievementId,
          name,
          description: description ?? "",
          type,
          targetValue: type === "incremental" ? targetValue : undefined,
          points,
        });
        const result = { gameId, achievementId, type, targetValue: type === "incremental" ? (targetValue ?? null) : null, points };
        return ok(
          `Added achievement ${achievementId} (${name}, ${type}${result.targetValue ? `, target ${result.targetValue}` : ""}, ` +
            `${points} points). Run sync_simulator_config so the Editor Simulator knows it.`,
          result,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );
}
