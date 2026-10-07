import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import type { ApiClient } from "../api/client.js";
import { PLATFORM_CONFIG_PATH, SIMULATOR_CONFIG_PATH, readProjectGameKey, resolveProjectRoot } from "../unity/project.js";
import { ToolInputError, fail, ok } from "./result.js";
import { type ApiGame, gameIdSchema } from "./shared.js";

interface SimulatorConfig {
  format: number;
  game: { gameId: string; gameKey: string | null; name: string | null };
  [key: string]: unknown;
}

export function registerSimulatorTools(server: McpServer, api: ApiClient, cwd: () => string = () => process.cwd()): void {
  server.registerTool(
    "sync_simulator_config",
    {
      title: "Sync the Editor Simulator configuration",
      description:
        "Downloads the game's configuration for the SusaPlay Editor Simulator — achievements, economy items, ad " +
        "settings and the store — and writes it to ProjectSettings/Packages/com.susaplay.sdk/SimulatorConfig.json " +
        "in the Unity project, replacing the file. Nothing on the platform changes. The game is the one whose " +
        "game key the project's PlatformConfig holds, unless gameId is given.",
      inputSchema: z.object({
        projectPath: z.string().optional().describe("The Unity project folder; defaults to the open workspace"),
        gameId: gameIdSchema.optional(),
      }),
      outputSchema: z.object({
        gameId: z.string(),
        gameName: z.string().nullable(),
        file: z.string(),
        achievements: z.number(),
        items: z.number(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectPath, gameId }) => {
      try {
        const root = await resolveProjectRoot(projectPath, cwd());
        const key = await readProjectGameKey(root);
        const projectKey = key.kind === "found" ? key.gameKey : null;

        let targetId = gameId;
        if (!targetId) {
          if (!projectKey) {
            throw new ToolInputError(
              key.kind === "binary"
                ? `${PLATFORM_CONFIG_PATH} uses binary serialization and cannot be read. Pass gameId.`
                : `The project has no game key in ${PLATFORM_CONFIG_PATH}. Set it with SusaPlay → Setup in Unity, or pass gameId.`,
            );
          }
          const { games } = await api.get<{ games: ApiGame[] }>("/catalog/games");
          const match = games.find((game) => game.gameKey === projectKey);
          if (!match) {
            throw new ToolInputError(
              "The game key in this project's PlatformConfig belongs to none of your games. Check the key in " +
                "SusaPlay → Setup against the Developer Portal, or use an API key of the developer who owns the game.",
            );
          }
          targetId = match.gameId;
        }

        const config = await api.get<SimulatorConfig>(`/catalog/game/${encodeURIComponent(targetId)}/simulator-config`);
        // Writing another game's configuration into this project would make the
        // Simulator behave like the wrong game.
        if (projectKey && config.game?.gameKey && config.game.gameKey !== projectKey) {
          throw new ToolInputError(
            `Game ${targetId} is not the game this project is set up for: its game key differs from the one in ` +
              `${PLATFORM_CONFIG_PATH}. Nothing was written.`,
          );
        }

        const file = join(root, SIMULATOR_CONFIG_PATH);
        await mkdir(dirname(file), { recursive: true });
        // Indented and newline-terminated like the Developer Portal's download, so
        // the committed file diffs the same either way.
        await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");

        const count = (value: unknown) => (Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 0);
        const result = {
          gameId: targetId,
          gameName: config.game?.name ?? null,
          file: SIMULATOR_CONFIG_PATH,
          achievements: count(config.achievements),
          items: count(config.items),
        };
        return ok(
          `Wrote ${SIMULATOR_CONFIG_PATH} for ${result.gameName ?? targetId} (${result.achievements} achievements, ` +
            `${result.items} items). The Editor Simulator reads it on the next Play. Commit the file so everyone ` +
            "on the project tests against the same configuration.",
          result,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );
}
