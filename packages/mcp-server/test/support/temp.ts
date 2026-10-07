import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

/** A fresh folder under the system temp folder, deleted by `removeTempDirs`. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Deletes every folder `tempDir` made; call it from `afterAll`. */
export function removeTempDirs(): void {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
}
