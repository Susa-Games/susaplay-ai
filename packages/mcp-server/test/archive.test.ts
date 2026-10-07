import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ZipArchive } from "../src/unity/archive.js";
import { writeZip } from "./support/zip-writer.js";

describe("ZipArchive", () => {
  it("lists entries and reads stored and deflated content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "susaplay-zip-"));
    for (const deflate of [false, true]) {
      const file = join(dir, `build-${deflate}.zip`);
      writeFileSync(file, writeZip({ "index.html": "<html>hi</html>", "Build/": "" }, { deflate }));
      const archive = await ZipArchive.open(file);
      expect(archive.entries.map((entry) => entry.name)).toEqual(["index.html", "Build/"]);
      expect((await archive.read(archive.entries[0]!)).toString()).toBe("<html>hi</html>");
      await archive.close();
    }
  });

  it("refuses a file that is not a zip", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "susaplay-zip-")), "not.zip");
    writeFileSync(file, "plain text");
    await expect(ZipArchive.open(file)).rejects.toThrow("not a zip file");
  });
});
