import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { RUNTIME_PATH } from "./catalog.js";
import { isTextSerialized, metaGuid, nestedId, scalar } from "./yaml.js";

export const ADDRESSABLES_DATA = "Assets/AddressableAssetsData";
const SETTINGS_FILE = `${ADDRESSABLES_DATA}/AddressableAssetSettings.asset`;

// BundledAssetGroupSchema.BundleNamingStyle, in the package source.
export const BUNDLE_NAMING_NO_HASH = 1;

export interface AddressablesGroup {
  name: string;
  file: string;
  isDefault: boolean;
  includeInBuild: boolean;
  bundleNaming: number | null;
  /** The resolved load path in the active profile, e.g. `https://…` or `{…RuntimePath}/[BuildTarget]`. */
  loadPath: string | null;
  remote: boolean;
}

export interface AddressablesSetup {
  textSerialized: boolean;
  buildRemoteCatalog: boolean;
  enableJsonCatalog: boolean;
  /** `m_overridePlayerVersion`; empty means a timestamp-named catalog. */
  playerVersionOverride: string;
  activeProfile: string | null;
  groups: AddressablesGroup[];
}

/** Profile variables (`m_Id` → value) of the active profile, and its name. */
function activeProfileValues(settings: string): { name: string | null; values: Map<string, string> } {
  const activeId = scalar(settings, "m_ActiveProfileId");
  const values = new Map<string, string>();
  let name: string | null = null;
  // Each profile: "- m_InheritedParent: …\n  m_Id: <profile>\n  m_ProfileName: …\n  m_Values:\n  - m_Id/m_Value pairs".
  const profiles = settings.split(/\n {4}- m_InheritedParent:/).slice(1);
  for (const profile of profiles) {
    const id = /\n {6}m_Id: (\S+)/.exec(profile)?.[1];
    if (id !== activeId) continue;
    name = scalar(profile, "m_ProfileName");
    for (const match of profile.matchAll(/- m_Id: (\S+)\s*\n\s*m_Value: (.*)/g)) {
      values.set(match[1] ?? "", (match[2] ?? "").trim().replace(/^'(.*)'$/, "$1"));
    }
  }
  return { name, values };
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** `null` when the project has no Addressables settings. */
export async function readAddressablesSetup(root: string): Promise<AddressablesSetup | null> {
  const settings = await tryRead(join(root, SETTINGS_FILE));
  if (settings === null) return null;
  if (!isTextSerialized(settings)) {
    return { textSerialized: false, buildRemoteCatalog: false, enableJsonCatalog: false, playerVersionOverride: "", activeProfile: null, groups: [] };
  }
  const profile = activeProfileValues(settings);
  const defaultGroupGuid = scalar(settings, "m_DefaultGroup");

  // Groups are named by file; each schema points back to its group's asset GUID.
  const groupsDir = join(root, ADDRESSABLES_DATA, "AssetGroups");
  const groupByAssetGuid = new Map<string, AddressablesGroup>();
  let files: string[] = [];
  try {
    files = (await readdir(groupsDir)).filter((file) => file.endsWith(".asset")).sort();
  } catch {
    files = [];
  }
  for (const file of files) {
    const text = await tryRead(join(groupsDir, file));
    const meta = await tryRead(join(groupsDir, `${file}.meta`));
    const assetGuid = meta ? metaGuid(meta) : null;
    if (!text || !assetGuid) continue;
    groupByAssetGuid.set(assetGuid, {
      name: scalar(text, "m_GroupName") ?? file.replace(/\.asset$/, ""),
      file: `${ADDRESSABLES_DATA}/AssetGroups/${file}`,
      isDefault: scalar(text, "m_GUID") === defaultGroupGuid,
      includeInBuild: true,
      bundleNaming: null,
      loadPath: null,
      remote: false,
    });
  }

  const schemasDir = join(groupsDir, "Schemas");
  let schemaFiles: string[] = [];
  try {
    schemaFiles = (await readdir(schemasDir)).filter((file) => file.endsWith(".asset"));
  } catch {
    schemaFiles = [];
  }
  for (const file of schemaFiles) {
    const text = await tryRead(join(schemasDir, file));
    if (!text || scalar(text, "m_BundleNaming") === null) continue; // not a BundledAssetGroupSchema
    const groupGuid = /m_Group: \{[^}]*guid: (\w+)/.exec(text)?.[1];
    const group = groupGuid ? groupByAssetGuid.get(groupGuid) : undefined;
    if (!group) continue;
    const loadPathId = nestedId(text, "m_LoadPath");
    const loadPath = loadPathId ? (profile.values.get(loadPathId) ?? loadPathId) : null;
    group.bundleNaming = Number.parseInt(scalar(text, "m_BundleNaming") ?? "", 10);
    group.includeInBuild = scalar(text, "m_IncludeInBuild") !== "0";
    group.loadPath = loadPath;
    group.remote = loadPath !== null && !loadPath.includes(RUNTIME_PATH) && /^(https?:)?\/\/|^http/i.test(loadPath);
  }

  return {
    textSerialized: true,
    buildRemoteCatalog: scalar(settings, "m_BuildRemoteCatalog") === "1",
    enableJsonCatalog: scalar(settings, "m_EnableJsonCatalog") === "1",
    playerVersionOverride: scalar(settings, "m_overridePlayerVersion") ?? "",
    activeProfile: profile.name,
    groups: [...groupByAssetGuid.values()],
  };
}
