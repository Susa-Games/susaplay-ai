import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface InstalledPackage {
  /** As written in `Packages/manifest.json`: a version or a git URL. */
  requested: string;
  /** The resolved version, when it can be known. */
  version: string | null;
  source: string | null;
}

async function readJson(path: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** A package as Unity resolved it: manifest, lock file, then the package cache for git packages. */
export async function readInstalledPackage(root: string, name: string): Promise<InstalledPackage | null> {
  const manifest = await readJson(join(root, "Packages/manifest.json"));
  const requested = manifest?.dependencies?.[name];
  if (typeof requested !== "string") return null;
  const locked = (await readJson(join(root, "Packages/packages-lock.json")))?.dependencies?.[name];
  let version: string | null = /^\d+\.\d+\.\d+/.test(locked?.version ?? "") ? locked.version : null;
  if (!version && /^\d+\.\d+\.\d+/.test(requested)) version = requested;
  if (!version) {
    // A git package's version is only in its package.json, under Library.
    try {
      const cache = join(root, "Library/PackageCache");
      for (const folder of (await readdir(cache)).filter((entry) => entry.startsWith(`${name}@`)).sort()) {
        const cached = await readJson(join(cache, folder, "package.json"));
        if (typeof cached?.version === "string") version = cached.version;
      }
    } catch {
      // No Library folder: a fresh clone that Unity has not opened yet.
    }
  }
  return { requested, version, source: typeof locked?.source === "string" ? locked.source : null };
}

/** -1, 0 or 1, comparing the numeric parts of two dotted versions. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}
