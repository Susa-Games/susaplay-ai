import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ZipArchive } from "../src/unity/archive.js";
import { crc32, writeZip } from "../src/unity/zip-writer.js";

const dir = mkdtempSync(join(tmpdir(), "susaplay-zip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const files: Record<string, Buffer> = {
  "index.html": Buffer.from("<html>".repeat(1000)),
  "Build/WebGL.loader.js": Buffer.from("loader"),
  "Build/empty.txt": Buffer.alloc(0),
  "StreamingAssets/aa/WebGL/größe.bundle": Buffer.from([0, 1, 2, 3, 255]),
};
for (const [name, content] of Object.entries(files)) {
  mkdirSync(join(dir, "in", name, ".."), { recursive: true });
  writeFileSync(join(dir, "in", name), content);
}
const inputs = Object.keys(files).map((name) => ({ name, path: join(dir, "in", name) }));

describe("writeZip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.from("6789"), crc32(Buffer.from("12345")))).toBe(0xcbf43926);
  });

  it("writes a zip a reader opens, deflating text and storing bundles", async () => {
    const target = join(dir, "a.zip");
    const progress: number[] = [];
    const size = await writeZip(target, inputs, (done) => {
      progress.push(done);
    });
    expect(size).toBe(readFileSync(target).length);
    expect(progress).toEqual([1, 2, 3, 4]);

    const archive = await ZipArchive.open(target);
    try {
      expect(archive.entries.map((entry) => entry.name)).toEqual(Object.keys(files));
      for (const entry of archive.entries) {
        expect(await archive.read(entry)).toEqual(files[entry.name]);
      }
      const byName = Object.fromEntries(archive.entries.map((entry) => [entry.name, entry]));
      expect(byName["index.html"]!.method).toBe(8);
      expect(byName["index.html"]!.compressedSize).toBeLessThan(6000);
      expect(byName["StreamingAssets/aa/WebGL/größe.bundle"]!.method).toBe(0);
    } finally {
      await archive.close();
    }
  });

  it("is reproducible: the same files give the same bytes", async () => {
    await writeZip(join(dir, "b.zip"), inputs);
    await writeZip(join(dir, "c.zip"), inputs);
    expect(readFileSync(join(dir, "b.zip")).equals(readFileSync(join(dir, "c.zip")))).toBe(true);
  });

  it("fails when a file disappears", async () => {
    await expect(writeZip(join(dir, "d.zip"), [{ name: "gone", path: join(dir, "nope") }])).rejects.toThrow();
  });
});
