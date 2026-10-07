import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A throwaway Unity project, written in the same text serialization Unity uses
// (the layout follows a real Unity 6 project with Addressables 2.9).
export interface ProjectOptions {
  sdkVersion?: string | null;
  gameKey?: string | null;
  simulatorGameKey?: string | null;
  addressables?: {
    version?: string;
    buildRemoteCatalog?: boolean;
    enableJsonCatalog?: boolean;
    playerVersionOverride?: string;
    remoteLoadPath?: string;
    defaultGroupRemote?: boolean;
    remoteBundleNaming?: number;
  } | null;
  webglDefines?: string[];
  binarySerialization?: boolean;
}

const PROFILE = "9fa53cbe64b094fab9078c378103489f";
const REMOTE_LOAD = "a0f4e5cd6ba9f4990a0c6abbb5fb109c";
const LOCAL_LOAD = "b3a67e7d546724e04a59dabe905f0c4c";
const DEFAULT_GROUP_GUID = "785a2947223554a6b8cfa4c4c126ea07";

export function makeProject(options: ProjectOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "susaplay-check-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const yaml = (body: string) => `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!114 &11400000\nMonoBehaviour:\n${body}`;

  mkdirSync(join(root, "Assets"), { recursive: true });
  write("ProjectSettings/EditorSettings.asset", options.binarySerialization ? "binary" : yaml("  m_SerializationMode: 2\n"));
  write(
    "ProjectSettings/ProjectSettings.asset",
    `%YAML 1.1\n--- !u!129 &1\nPlayerSettings:\n  bundleVersion: 1.0\n  scriptingDefineSymbols:\n    Standalone: A\n    WebGL: ${(options.webglDefines ?? []).join(";")}\n  additionalCompilerArguments: {}\n`,
  );

  const dependencies: Record<string, string> = {};
  const lock: Record<string, object> = {};
  if (options.sdkVersion !== null) {
    dependencies["com.susaplay.sdk"] = "https://github.com/Susa-Games/com.susaplay.sdk.git#latest";
    lock["com.susaplay.sdk"] = { version: "https://github.com/Susa-Games/com.susaplay.sdk.git#latest", source: "git" };
    write("Library/PackageCache/com.susaplay.sdk@8ef6bced/package.json", JSON.stringify({ version: options.sdkVersion ?? "1.9.1" }));
  }
  const aa = options.addressables;
  if (aa) {
    dependencies["com.unity.addressables"] = aa.version ?? "2.9.1";
    lock["com.unity.addressables"] = { version: aa.version ?? "2.9.1", source: "registry" };
  }
  write("Packages/manifest.json", JSON.stringify({ dependencies }));
  write("Packages/packages-lock.json", JSON.stringify({ dependencies: lock }));

  if (options.gameKey !== null) {
    write("Assets/Resources/PlatformConfig.asset", yaml(`  m_Name: PlatformConfig\n  _gameKey: ${options.gameKey ?? "gk_test"}\n`));
  }
  if (options.simulatorGameKey) {
    write(
      "ProjectSettings/Packages/com.susaplay.sdk/SimulatorConfig.json",
      JSON.stringify({ format: 1, game: { gameId: "g1", gameKey: options.simulatorGameKey, name: "Test" } }),
    );
  }

  if (aa) {
    const base = "Assets/AddressableAssetsData";
    write(
      `${base}/AddressableAssetSettings.asset`,
      yaml(
        `  m_Name: AddressableAssetSettings\n  m_DefaultGroup: ${DEFAULT_GROUP_GUID}\n  m_BuildRemoteCatalog: ${aa.buildRemoteCatalog === false ? 0 : 1}\n` +
          `  m_EnableJsonCatalog: ${aa.enableJsonCatalog ? 1 : 0}\n  m_overridePlayerVersion: ${aa.playerVersionOverride ?? "1"}\n` +
          `  m_ProfileSettings:\n    m_Profiles:\n    - m_InheritedParent: \n      m_Id: ${PROFILE}\n      m_ProfileName: Default\n      m_Values:\n` +
          `      - m_Id: ${REMOTE_LOAD}\n        m_Value: ${aa.remoteLoadPath ?? "https://games.susaplay.com/addressables/g1"}\n` +
          `      - m_Id: ${LOCAL_LOAD}\n        m_Value: '{UnityEngine.AddressableAssets.Addressables.RuntimePath}/[BuildTarget]'\n` +
          `  m_ActiveProfileId: ${PROFILE}\n`,
      ),
    );
    const group = (name: string, fileGuid: string, groupGuid: string, remote: boolean, naming: number) => {
      write(`${base}/AssetGroups/${name}.asset`, yaml(`  m_Name: ${name}\n  m_GroupName: ${name}\n  m_GUID: ${groupGuid}\n`));
      write(`${base}/AssetGroups/${name}.asset.meta`, `fileFormatVersion: 2\nguid: ${fileGuid}\n`);
      write(
        `${base}/AssetGroups/Schemas/${name}_BundledAssetGroupSchema.asset`,
        yaml(
          `  m_Group: {fileID: 11400000, guid: ${fileGuid}, type: 2}\n  m_IncludeInBuild: 1\n  m_LoadPath:\n    m_Id: ${remote ? REMOTE_LOAD : LOCAL_LOAD}\n  m_BundleNaming: ${naming}\n`,
        ),
      );
    };
    group("Default Local Group", "9e21c8d6f27e24e3d9f03a1749a88144", DEFAULT_GROUP_GUID, aa.defaultGroupRemote ?? true, 0);
    group("Remote Levels", "a9b8c7d6e5f4432109876543210fedcb", "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f", true, aa.remoteBundleNaming ?? 0);
  }
  return root;
}
