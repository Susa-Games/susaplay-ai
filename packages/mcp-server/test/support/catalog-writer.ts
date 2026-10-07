// Writes an Addressables binary catalog in the layout the Addressables package
// itself writes (BinaryStorageBuffer.Writer, ContentCatalogData.Serializer):
// size-prefixed data, locations as 7 uint32, internal IDs as '/'-split dynamic
// strings and providers as '.'-split ones. Only what the reader needs is
// written. The reader is also checked against a real Unity catalog where one is
// available (catalog.test.ts).

const UNICODE_FLAG = 0x80000000;
const DYNAMIC_FLAG = 0x40000000;
const NONE = 0xffffffff;
const MAGIC = 0x0de38942;
const BUNDLE_PROVIDER = "UnityEngine.ResourceManagement.ResourceProviders.AssetBundleProvider";
const ASSET_PROVIDER = "UnityEngine.ResourceManagement.ResourceProviders.BundledAssetProvider";

class Buffer32 {
  private chunks: Uint8Array[] = [];
  length = 0;

  /** Appends `data` with its 4-byte length before it; returns the offset of the data. */
  sized(data: Uint8Array): number {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, data.length, true);
    this.push(header);
    const offset = this.length;
    this.push(data);
    while (this.length % 4) this.push(new Uint8Array(1));
    return offset;
  }

  raw(data: Uint8Array): number {
    const offset = this.length;
    this.push(data);
    return offset;
  }

  private push(data: Uint8Array): void {
    this.chunks.push(data);
    this.length += data.length;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

const u32s = (...values: number[]) => {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true));
  return out;
};

function writeString(buffer: Buffer32, text: string, separator: string): number {
  const plain = (piece: string) => {
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7f]*$/.test(piece)) return buffer.sized(new TextEncoder().encode(piece));
    const utf16 = new Uint8Array(piece.length * 2);
    for (let index = 0; index < piece.length; index += 1) new DataView(utf16.buffer).setUint16(index * 2, piece.charCodeAt(index), true);
    return (buffer.sized(utf16) | UNICODE_FLAG) >>> 0;
  };
  const pieces = text.split(separator);
  if (pieces.length === 1) return plain(text);
  let next = NONE;
  for (const piece of pieces) {
    const node = buffer.raw(u32s(plain(piece), next));
    next = (node | DYNAMIC_FLAG) >>> 0;
  }
  return next;
}

/** A catalog with one asset location per bundle, as Unity lays them out. */
export function writeCatalog(bundleIds: string[], options: { version?: number } = {}): Uint8Array {
  const buffer = new Buffer32();
  buffer.raw(new Uint8Array(32)); // header, filled in below
  const locations: number[] = [];
  for (const internalId of bundleIds) {
    locations.push(
      buffer.raw(u32s(writeString(buffer, internalId.split("/").pop() ?? "", "/"), writeString(buffer, internalId, "/"), writeString(buffer, BUNDLE_PROVIDER, "."), NONE, 0, NONE, NONE)),
    );
  }
  // An asset location, which is not a bundle and must be ignored.
  locations.push(buffer.raw(u32s(writeString(buffer, "Assets/Hero.prefab", "/"), writeString(buffer, "Assets/Hero.prefab", "/"), writeString(buffer, ASSET_PROVIDER, "."), NONE, 0, NONE, NONE)));
  const keyData: number[] = [];
  for (const location of locations) {
    const set = buffer.sized(u32s(location));
    keyData.push(NONE, set);
  }
  const keysOffset = buffer.sized(u32s(...keyData));
  const bytes = buffer.bytes();
  new DataView(bytes.buffer).setInt32(0, MAGIC, true);
  new DataView(bytes.buffer).setUint32(4, options.version ?? 2, true);
  new DataView(bytes.buffer).setUint32(8, keysOffset, true);
  return bytes;
}
