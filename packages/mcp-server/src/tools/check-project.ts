import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/errors.js";
import { BUNDLE_NAMING_NO_HASH, readAddressablesSetup } from "../unity/addressables.js";
import { compareVersions, readInstalledPackage } from "../unity/packages.js";
import { PLATFORM_CONFIG_PATH, SIMULATOR_CONFIG_PATH, readProjectGameKey, resolveProjectRoot } from "../unity/project.js";
import { readPlayerSettings, readsAsText } from "../unity/project-settings.js";
import { fail, ok } from "./result.js";
import type { ApiGame } from "./shared.js";

/** The newest SusaPlay SDK this server release knows of; SP002 compares against it. */
export const LATEST_KNOWN_SDK = "1.9.1";
const ADDRESSABLES_BASE = "https://games.susaplay.com/addressables/";

export type Severity = "error" | "warning" | "info";
export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  file?: string;
}

const findingSchema = z.object({
  id: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  file: z.string().optional(),
});

interface ProjectReport {
  projectPath: string;
  sdkVersion: string | null;
  gameKey: string | null;
  game: { gameId: string; name: string } | null;
  addressablesVersion: string | null;
  findings: Finding[];
}

/** Every check that needs only the project's files, plus SP004 when a key is set. */
export async function checkProject(root: string, api: ApiClient): Promise<ProjectReport> {
  const findings: Finding[] = [];
  const add = (finding: Finding) => findings.push(finding);

  if (!(await readsAsText(root))) {
    add({
      id: "SP020",
      severity: "info",
      message: "The project uses binary asset serialization, so its settings cannot be inspected. Switch to Force Text (Project Settings → Editor → Asset Serialization) to enable these checks.",
      file: "ProjectSettings/EditorSettings.asset",
    });
  }

  const sdk = await readInstalledPackage(root, "com.susaplay.sdk");
  if (!sdk) {
    add({ id: "SP001", severity: "error", message: "The SusaPlay SDK (com.susaplay.sdk) is not installed.", file: "Packages/manifest.json" });
  } else if (sdk.version && compareVersions(sdk.version, LATEST_KNOWN_SDK) < 0) {
    add({
      id: "SP002",
      severity: "warning",
      message: `SusaPlay SDK ${sdk.version} is older than ${LATEST_KNOWN_SDK}. Update it to get the current fixes.`,
      file: "Packages/manifest.json",
    });
  }

  const key = await readProjectGameKey(root);
  const gameKey = key.kind === "found" ? key.gameKey : null;
  if (key.kind === "missing" || key.kind === "empty") {
    add({
      id: "SP003",
      severity: "error",
      message: key.kind === "missing"
        ? "There is no PlatformConfig asset, so the SDK cannot start. Create it with SusaPlay → Setup."
        : "The PlatformConfig asset has no game key. Set it with SusaPlay → Setup.",
      file: PLATFORM_CONFIG_PATH,
    });
  }

  // SP004 needs the developer's games; without a key it is reported as unchecked.
  let game: ProjectReport["game"] = null;
  if (gameKey) {
    if (!api.hasKey) {
      add({ id: "SP004", severity: "info", message: "Not checked whether the game key belongs to one of your games: no SusaPlay API key is set." });
    } else {
      try {
        const { games } = await api.get<{ games: ApiGame[] }>("/catalog/games");
        const match = games.find((entry) => entry.gameKey === gameKey);
        if (match) {
          game = { gameId: match.gameId, name: match.name ?? match.gameId };
        } else {
          add({
            id: "SP004",
            severity: "error",
            message: "The game key in PlatformConfig belongs to none of your games. Copy the key from the Developer Portal into SusaPlay → Setup.",
            file: PLATFORM_CONFIG_PATH,
          });
        }
      } catch (error) {
        const reason = error instanceof ApiError ? error.code : "unexpected error";
        add({ id: "SP004", severity: "info", message: `Not checked whether the game key belongs to one of your games (${reason}).` });
      }
    }
  }

  if (sdk) {
    let simulator: { game?: { gameKey?: string } } | null = null;
    try {
      simulator = JSON.parse(await readFile(join(root, SIMULATOR_CONFIG_PATH), "utf8"));
    } catch {
      simulator = null;
    }
    if (!simulator) {
      add({
        id: "SP005",
        severity: "info",
        message: "No Editor Simulator configuration: in the Editor the game behaves as if nothing is configured. Run sync_simulator_config to download it.",
        file: SIMULATOR_CONFIG_PATH,
      });
    } else if (gameKey && simulator.game?.gameKey && simulator.game.gameKey !== gameKey) {
      add({
        id: "SP006",
        severity: "warning",
        message: "The Editor Simulator configuration belongs to another game: its game key differs from PlatformConfig. Run sync_simulator_config.",
        file: SIMULATOR_CONFIG_PATH,
      });
    }
  }

  const addressablesPackage = await readInstalledPackage(root, "com.unity.addressables");
  const setup = addressablesPackage ? await readAddressablesSetup(root) : null;
  if (setup?.textSerialized) {
    const remoteGroups = setup.groups.filter((group) => group.includeInBuild && group.remote);
    const settingsFile = "Assets/AddressableAssetsData/AddressableAssetSettings.asset";

    if (remoteGroups.length && !setup.buildRemoteCatalog) {
      add({
        id: "SP011",
        severity: "error",
        message: `Remote groups exist (${remoteGroups.map((group) => group.name).join(", ")}) but Build Remote Catalog is off, so players never load updated content.`,
        file: settingsFile,
      });
    }

    // One finding per wrong path, naming every group that uses it.
    const expected = game ? `${ADDRESSABLES_BASE}${game.gameId}` : null;
    const wrongPaths = new Map<string, string[]>();
    for (const group of remoteGroups) {
      const loadPath = (group.loadPath ?? "").replace(/\/+$/, "");
      if (expected ? loadPath !== expected : !loadPath.startsWith(ADDRESSABLES_BASE)) {
        wrongPaths.set(group.loadPath ?? "", [...(wrongPaths.get(group.loadPath ?? "") ?? []), group.name]);
      }
    }
    for (const [loadPath, names] of wrongPaths) {
      add({
        id: "SP010",
        severity: "error",
        message: `${names.map((name) => `"${name}"`).join(", ")} load${names.length === 1 ? "s" : ""} from ${loadPath || "an empty path"}${setup.activeProfile ? ` (profile "${setup.activeProfile}")` : ""}; the Remote Load Path must be ${expected ? `${expected}/` : `${ADDRESSABLES_BASE}<gameId>/`}.`,
        file: settingsFile,
      });
    }
    for (const group of remoteGroups) {
      if (group.bundleNaming === BUNDLE_NAMING_NO_HASH) {
        add({
          id: "SP014",
          severity: "error",
          message: `Group "${group.name}" names bundles without a hash; SusaPlay refuses such bundles at upload. Set Bundle Naming Mode to "Append Hash to Filename".`,
          file: group.file,
        });
      }
    }

    if (setup.buildRemoteCatalog) {
      const defaultGroup = setup.groups.find((group) => group.isDefault);
      if (defaultGroup && !defaultGroup.remote) {
        add({
          id: "SP012",
          severity: "warning",
          message: `The default group "${defaultGroup.name}" is local, so Unity's built-in data and MonoScripts bundles ship inside the player build. Every content update is then tied to one build: content built with a new build breaks the old one. Make the default group remote.`,
          file: defaultGroup.file,
        });
      }
      const override = setup.playerVersionOverride;
      if (!override || override.includes("[UnityEditor.PlayerSettings.bundleVersion]")) {
        add({
          id: "SP013",
          severity: "warning",
          message: override
            ? "The Player Version Override follows bundleVersion, so the catalog's name changes with every version bump and an older build stops finding new content. Set a constant, such as 1."
            : "There is no Player Version Override, so the catalog is named by build time and a new build stops reading content published for the old one. Set a constant, such as 1.",
          file: settingsFile,
        });
      }

      // SP015: SusaPlay accepts only binary catalogs.
      const version = addressablesPackage?.version ?? null;
      const player = await readPlayerSettings(root);
      let jsonReason: string | null = null;
      if (version && compareVersions(version, "2.0.0") >= 0) {
        if (setup.enableJsonCatalog) jsonReason = `Addressables ${version} has Enable Json Catalog on. Turn it off.`;
      } else if (version && compareVersions(version, "1.21.3") < 0) {
        jsonReason = `Addressables ${version} writes only JSON catalogs. Update to 1.21.3 or later and add ENABLE_BINARY_CATALOG, or move to Addressables 2.`;
      } else if (version && !player?.webglDefines.includes("ENABLE_BINARY_CATALOG")) {
        jsonReason = `Addressables ${version} writes JSON unless ENABLE_BINARY_CATALOG is in the WebGL scripting define symbols. Add it.`;
      }
      if (jsonReason) {
        add({ id: "SP015", severity: "error", message: `The catalog will be JSON, which SusaPlay refuses. ${jsonReason}`, file: settingsFile });
      }
    }
  }

  return {
    projectPath: root,
    sdkVersion: sdk?.version ?? null,
    gameKey,
    game,
    addressablesVersion: addressablesPackage?.version ?? null,
    findings,
  };
}

export function registerCheckProjectTool(server: McpServer, api: ApiClient, cwd: () => string = () => process.cwd()): void {
  server.registerTool(
    "check_project",
    {
      title: "Check a Unity project's SusaPlay setup",
      description:
        "Reads a Unity project's files and reports SusaPlay integration mistakes, each with a stable ID: the SDK " +
        "and its version, the game key, the Editor Simulator configuration, and the Addressables setup — Remote " +
        "Load Path, remote catalog, built-in data placement, catalog naming, bundle naming and binary catalogs. " +
        "Works offline; with an API key it also checks that the game key is one of your games.",
      inputSchema: z.object({
        projectPath: z.string().optional().describe("The Unity project folder; defaults to the open workspace"),
      }),
      outputSchema: z.object({
        projectPath: z.string(),
        passed: z.boolean(),
        sdkVersion: z.string().nullable(),
        gameKey: z.string().nullable(),
        game: z.object({ gameId: z.string(), name: z.string() }).nullable(),
        addressablesVersion: z.string().nullable(),
        findings: z.array(findingSchema),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ projectPath }) => {
      try {
        const root = await resolveProjectRoot(projectPath, cwd());
        const report = await checkProject(root, api);
        const passed = !report.findings.some((finding) => finding.severity === "error");
        const lines = [
          `${passed ? "No errors" : "Problems found"} in ${root}${report.game ? ` (${report.game.name}, ${report.game.gameId})` : ""}.`,
          ...report.findings.map((finding) => `- ${finding.id} ${finding.severity}: ${finding.message}`),
        ];
        if (!report.findings.length) lines.push("Everything checked looks right.");
        return ok(lines.join("\n"), { ...report, passed });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
