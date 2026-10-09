/**
 * Reads the bundle locations out of an Addressables binary catalog
 * (`catalog_*.bin`, Addressables 2.x and 1.21.3+ with ENABLE_BINARY_CATALOG).
 *
 * The format, from the Addressables package source (BinaryStorageBuffer.cs and
 * ContentCatalogData.cs):
 *
 * - A header at offset 0: magic, version (2), the offset of the key array, …
 * - Arrays and strings are stored with their byte length in the 4 bytes before
 *   their offset.
 * - Each key points to an array of location offsets. A location is 7 uint32:
 *   primary key, internal ID, provider, dependencies, dependency hash, extra
 *   data, type.
 * - A string ID with bit 31 set is UTF-16LE, otherwise ASCII. With bit 30 set it
 *   is a "dynamic" string: a linked list of (piece, next) pairs read from the
 *   last piece back to the first, joined by a separator — '/' for internal IDs,
 *   '.' for provider names. A URL is therefore never stored in one piece, which
 *   is why a byte scan cannot check it.
 */

const UNICODE_FLAG = 0x80000000;
const DYNAMIC_FLAG = 0x40000000;
const CLEAR_FLAGS = 0x3fffffff;
const NONE = 0xffffffff;
const CATALOG_DATA_VERSION = 2;
const BUNDLE_PROVIDER_SUFFIX = "AssetBundleProvider";

export const RUNTIME_PATH = "{UnityEngine.AddressableAssets.Addressables.RuntimePath}";

export class CatalogFormatError extends Error {}

/**
 * The file a URL loads from a game's Remote Load Path (`base`, ending in "/"),
 * or `null` when SusaPlay's CDN would not serve it. Unity writes the catalog URL
 * as "{base}/catalog_x.hash", so a Remote Load Path ending in "/" gives "//";
 * the CDN accepts repeated slashes there, but not a deeper path.
 */
export function servedFileName(url: string, base: string): string | null {
  if (!url.startsWith(base)) return null;
  const rest = url.slice(base.length).replace(/^\/+/, "");
  return rest && !rest.includes("/") ? rest : null;
}

export interface CatalogBundle {
  /** The location as the player resolves it, e.g. `https://…/x.bundle` or `{…RuntimePath}/WebGL/x.bundle`. */
  internalId: string;
  /** The file name the location ends in. */
  fileName: string;
  /** Inside the player build (`StreamingAssets/aa`) rather than downloaded. */
  local: boolean;
}

class Reader {
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u32(offset: number): number {
    if (offset < 0 || offset + 4 > this.bytes.length) {
      throw new CatalogFormatError(`offset ${offset} is outside the catalog`);
    }
    return this.view.getUint32(offset, true);
  }

  /** Byte length of the array or string stored at `offset`. */
  private size(offset: number): number {
    const size = this.u32(offset - 4);
    if (offset + size > this.bytes.length) {
      throw new CatalogFormatError(`data at ${offset} runs past the end of the catalog`);
    }
    return size;
  }

  uintArray(offset: number): number[] {
    if (offset === NONE) return [];
    const count = this.size(offset) / 4;
    return Array.from({ length: count }, (_, index) => this.u32(offset + index * 4));
  }

  private plainString(id: number): string {
    if ((id & UNICODE_FLAG) >>> 0 === UNICODE_FLAG) {
      const offset = id & CLEAR_FLAGS;
      return new TextDecoder("utf-16le").decode(this.bytes.subarray(offset, offset + this.size(offset)));
    }
    return new TextDecoder("latin1").decode(this.bytes.subarray(id, id + this.size(id)));
  }

  string(id: number, separator: string): string | null {
    if (id === NONE) return null;
    if ((id & DYNAMIC_FLAG) === 0) return this.plainString(id);
    const parts: string[] = [];
    let next = id;
    for (let guard = 0; next !== NONE; guard += 1) {
      if (guard > 4096) throw new CatalogFormatError("a string in the catalog does not end");
      const offset = next & CLEAR_FLAGS;
      parts.push(this.plainString(this.u32(offset)));
      next = this.u32(offset + 4);
    }
    return parts.reverse().join(separator);
  }
}

/** Every AssetBundle location the catalog names, once each. */
export function readCatalogBundles(data: Uint8Array): CatalogBundle[] {
  if (data.length < 32) throw new CatalogFormatError("too short to be an Addressables binary catalog");
  const reader = new Reader(data);
  const version = reader.u32(4);
  if (version !== CATALOG_DATA_VERSION) {
    throw new CatalogFormatError(`catalog data version ${version}; this reader understands version ${CATALOG_DATA_VERSION}`);
  }
  const keysOffset = reader.u32(8);
  const keyCount = reader.uintArray(keysOffset).length / 2;
  const locations = new Set<number>();
  for (let index = 0; index < keyCount; index += 1) {
    const locationSet = reader.u32(keysOffset + index * 8 + 4);
    for (const location of reader.uintArray(locationSet)) locations.add(location);
  }

  const bundles = new Map<string, CatalogBundle>();
  for (const location of locations) {
    const provider = reader.string(reader.u32(location + 8), ".");
    if (!provider?.endsWith(BUNDLE_PROVIDER_SUFFIX)) continue;
    const internalId = reader.string(reader.u32(location + 4), "/");
    if (!internalId) continue;
    bundles.set(internalId, {
      internalId,
      fileName: internalId.slice(internalId.lastIndexOf("/") + 1),
      local: internalId.startsWith(RUNTIME_PATH),
    });
  }
  return [...bundles.values()].sort((a, b) => a.internalId.localeCompare(b.internalId));
}
