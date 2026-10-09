import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CatalogFormatError, RUNTIME_PATH, readCatalogBundles, servedFileName } from "../src/unity/catalog.js";
import { writeCatalog } from "./support/catalog-writer.js";

describe("readCatalogBundles", () => {
  it("finds every bundle location, local and remote, and ignores asset locations", () => {
    const bundles = readCatalogBundles(
      writeCatalog([
        `${RUNTIME_PATH}/WebGL/21dbcbd8_monoscripts_660d.bundle`,
        "https://games.susaplay.com/addressables/g1/levels_ab12.bundle",
      ]),
    );
    expect(bundles).toEqual([
      { internalId: `${RUNTIME_PATH}/WebGL/21dbcbd8_monoscripts_660d.bundle`, fileName: "21dbcbd8_monoscripts_660d.bundle", local: true },
      { internalId: "https://games.susaplay.com/addressables/g1/levels_ab12.bundle", fileName: "levels_ab12.bundle", local: false },
    ]);
  });

  it("decodes a piece stored as UTF-16 because it is not ASCII", () => {
    const [bundle] = readCatalogBundles(writeCatalog(["https://games.susaplay.com/addressables/g1/niveau_é_1.bundle"]));
    expect(bundle?.fileName).toBe("niveau_é_1.bundle");
  });

  it("refuses an unknown catalog version and a truncated file", () => {
    expect(() => readCatalogBundles(writeCatalog([], { version: 3 }))).toThrow(CatalogFormatError);
    const whole = writeCatalog(["https://games.susaplay.com/addressables/g1/a.bundle"]);
    expect(() => readCatalogBundles(whole.subarray(0, whole.length - 20))).toThrow(CatalogFormatError);
    expect(() => readCatalogBundles(new Uint8Array(10))).toThrow(CatalogFormatError);
  });

  // A catalog Unity wrote (Unity 6, Addressables 2.9). Set SUSAPLAY_REAL_CATALOG to
  // run it; the file is not in this repository.
  const real = process.env.SUSAPLAY_REAL_CATALOG;
  it.skipIf(!real || !existsSync(real))("reads a catalog Unity wrote", () => {
    const bundles = readCatalogBundles(readFileSync(real!));
    expect(bundles.length).toBeGreaterThan(0);
    for (const bundle of bundles) expect(bundle.fileName).toMatch(/\.bundle$/);
  });
});

describe("servedFileName", () => {
  const base = "https://games.susaplay.com/addressables/g1/";
  it("names the file the CDN serves, with repeated slashes accepted and deeper paths refused", () => {
    expect(servedFileName(`${base}catalog_1.hash`, base)).toBe("catalog_1.hash");
    expect(servedFileName(`${base}//catalog_1.hash`, base)).toBe("catalog_1.hash");
    expect(servedFileName(`${base}v2/catalog_1.hash`, base)).toBeNull();
    expect(servedFileName(base, base)).toBeNull();
    expect(servedFileName("https://games.susaplay.com/addressables/g10/x.bundle", base)).toBeNull();
  });
});
