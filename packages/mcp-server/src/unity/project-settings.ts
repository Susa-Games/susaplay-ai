import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isTextSerialized, scalar } from "./yaml.js";

export interface PlayerSettings {
  textSerialized: boolean;
  bundleVersion: string | null;
  webglDefines: string[];
}

export async function readPlayerSettings(root: string): Promise<PlayerSettings | null> {
  let text: string;
  try {
    text = await readFile(join(root, "ProjectSettings/ProjectSettings.asset"), "utf8");
  } catch {
    return null;
  }
  if (!isTextSerialized(text)) return { textSerialized: false, bundleVersion: null, webglDefines: [] };
  // scriptingDefineSymbols:\n    WebGL: A;B;C
  const block = /scriptingDefineSymbols:\s*\n((?:[ \t]+\S+:.*\n?)*)/.exec(text)?.[1] ?? "";
  const webgl = /^[ \t]+WebGL:[ \t]*(.*)$/m.exec(block)?.[1] ?? "";
  return {
    textSerialized: true,
    bundleVersion: scalar(text, "bundleVersion"),
    webglDefines: webgl.split(";").map((define) => define.trim()).filter(Boolean),
  };
}

/** Unity's asset serialization mode: 2 is Force Text, which these checks need. */
export async function readsAsText(root: string): Promise<boolean> {
  try {
    const text = await readFile(join(root, "ProjectSettings/EditorSettings.asset"), "utf8");
    if (!isTextSerialized(text)) return false;
    const mode = scalar(text, "m_SerializationMode");
    return mode === null || mode === "2";
  } catch {
    return true;
  }
}
