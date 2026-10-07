import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { ToolInputError } from "../tools/result.js";
import { ZipArchive, ZipFormatError } from "./archive.js";

/** OS leftovers the server skips at any depth (build_storage.py `_is_junk_entry`). */
const JUNK_BASENAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
export function isJunk(name: string): boolean {
  if (name.startsWith("__MACOSX/") || name.includes("/__MACOSX/")) return true;
  const base = name.slice(name.lastIndexOf("/") + 1);
  return JUNK_BASENAMES.has(base) || base.startsWith("._");
}

/** The single folder every file sits in, as the server strips it; `""` when there is none. */
export function singleRootPrefix(names: string[]): string {
  const roots = new Set(names.map((name) => (name.includes("/") ? name.slice(0, name.indexOf("/") + 1) : "")));
  if (roots.size !== 1) return "";
  const [root] = [...roots];
  return root ?? "";
}

/** A build as the server will see it, from a folder or a zip. */
export interface BuildSource {
  kind: "zip" | "folder";
  /** Every entry the server counts, directories and junk included (zip only; files for a folder). */
  entryCount: number;
  zippedBytes: number | null;
  /** Files the server keeps, by name after the single root folder is stripped, with their size. */
  files: Map<string, number>;
  junk: string[];
  /** The original names of `files`, for the loader check, which the server runs on unstripped names. */
  originalNames: string[];
  read(name: string): Promise<Buffer | null>;
  close(): Promise<void>;
}

async function walk(root: string, dir: string, out: Array<{ name: string; size: number }>): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out);
    } else if (entry.isFile()) {
      out.push({ name: relative(root, full).split(sep).join("/"), size: (await stat(full)).size });
    }
  }
}

export async function openBuild(path: string): Promise<BuildSource> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new ToolInputError(`${path} does not exist. Pass buildPath with the WebGL build folder or its .zip.`);
  }

  if (info.isDirectory()) {
    const all: Array<{ name: string; size: number }> = [];
    await walk(path, path, all);
    const kept = all.filter((file) => !isJunk(file.name));
    const prefix = singleRootPrefix(kept.map((file) => file.name));
    return {
      kind: "folder",
      entryCount: all.length,
      zippedBytes: null,
      files: new Map(kept.map((file) => [file.name.slice(prefix.length), file.size])),
      junk: all.filter((file) => isJunk(file.name)).map((file) => file.name),
      originalNames: kept.map((file) => file.name),
      read: async (name) => {
        try {
          return await readFile(join(path, prefix, name));
        } catch {
          return null;
        }
      },
      close: async () => undefined,
    };
  }

  let archive: ZipArchive;
  try {
    archive = await ZipArchive.open(path);
  } catch (error) {
    if (error instanceof ZipFormatError) throw new ToolInputError(`${path} could not be read as a zip: ${error.message}.`);
    throw error;
  }
  const entries = archive.entries.filter((entry) => !entry.name.endsWith("/"));
  const kept = entries.filter((entry) => !isJunk(entry.name));
  const prefix = singleRootPrefix(kept.map((entry) => entry.name));
  const byName = new Map(kept.map((entry) => [entry.name.slice(prefix.length), entry]));
  return {
    kind: "zip",
    entryCount: archive.entries.length,
    zippedBytes: archive.size,
    files: new Map([...byName].map(([name, entry]) => [name, entry.size])),
    junk: entries.filter((entry) => isJunk(entry.name)).map((entry) => entry.name),
    originalNames: kept.map((entry) => entry.name),
    read: async (name) => {
      const entry = byName.get(name);
      return entry ? archive.read(entry) : null;
    },
    close: () => archive.close(),
  };
}
