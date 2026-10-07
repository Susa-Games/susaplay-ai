import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { ToolInputError } from "../tools/result.js";

export const PLATFORM_CONFIG_PATH = "Assets/Resources/PlatformConfig.asset";
export const SIMULATOR_CONFIG_PATH = "ProjectSettings/Packages/com.susaplay.sdk/SimulatorConfig.json";

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The Unity project to work on: the given path, or the folder the client started
 * the server in, which Claude Code and Cursor set to the open workspace.
 */
export async function resolveProjectRoot(projectPath: string | undefined, cwd: string = process.cwd()): Promise<string> {
  const root = projectPath ? (isAbsolute(projectPath) ? projectPath : resolve(cwd, projectPath)) : cwd;
  if (!(await isDirectory(join(root, "Assets"))) || !(await isDirectory(join(root, "ProjectSettings")))) {
    throw new ToolInputError(
      `${root} is not a Unity project: it has no Assets and ProjectSettings folders. ` +
        "Pass projectPath with the folder that contains them.",
    );
  }
  return root;
}

export type GameKeyReading =
  | { kind: "found"; gameKey: string }
  | { kind: "empty" }
  | { kind: "missing" }
  | { kind: "binary" };

/** The game key in the project's PlatformConfig asset, which the SDK loads at start. */
export async function readProjectGameKey(root: string): Promise<GameKeyReading> {
  let text: string;
  try {
    text = await readFile(join(root, PLATFORM_CONFIG_PATH), "utf8");
  } catch {
    return { kind: "missing" };
  }
  // Force Text serialization (Unity's default) writes YAML; binary serialization
  // cannot be read without Unity.
  if (!text.startsWith("%YAML")) {
    return { kind: "binary" };
  }
  const match = /^\s*_gameKey:\s*(.*)$/m.exec(text);
  const value = (match?.[1] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  return value ? { kind: "found", gameKey: value } : { kind: "empty" };
}
