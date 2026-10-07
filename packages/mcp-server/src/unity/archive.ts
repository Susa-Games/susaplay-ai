import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * A minimal reader for the zip a Unity WebGL build is uploaded as: the central
 * directory, and the content of an entry on request (stored or deflated). No
 * ZIP64: an upload is capped at 500 MB and 1000 entries, well inside plain zip.
 */
export interface ZipEntry {
  name: string;
  compressedSize: number;
  size: number;
  method: number;
  localHeaderOffset: number;
}

export class ZipFormatError extends Error {}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export class ZipArchive {
  private constructor(
    private readonly handle: Awaited<ReturnType<typeof open>>,
    readonly size: number,
    readonly entries: ZipEntry[],
  ) {}

  static async open(path: string): Promise<ZipArchive> {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const tailLength = Math.min(size, 22 + 0xffff);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, size - tailLength);
      let eocd = -1;
      for (let index = tailLength - 22; index >= 0; index -= 1) {
        if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
          eocd = index;
          break;
        }
      }
      if (eocd < 0) throw new ZipFormatError("not a zip file");
      const count = tail.readUInt16LE(eocd + 10);
      const directorySize = tail.readUInt32LE(eocd + 12);
      const directoryOffset = tail.readUInt32LE(eocd + 16);
      if (count === 0xffff || directoryOffset === 0xffffffff) {
        throw new ZipFormatError("ZIP64 archives are not supported; a SusaPlay upload is at most 500 MB");
      }
      const directory = Buffer.alloc(directorySize);
      await handle.read(directory, 0, directorySize, directoryOffset);
      const entries: ZipEntry[] = [];
      let cursor = 0;
      for (let index = 0; index < count; index += 1) {
        if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new ZipFormatError("damaged central directory");
        const method = directory.readUInt16LE(cursor + 10);
        const compressedSize = directory.readUInt32LE(cursor + 20);
        const entrySize = directory.readUInt32LE(cursor + 24);
        const nameLength = directory.readUInt16LE(cursor + 28);
        const extraLength = directory.readUInt16LE(cursor + 30);
        const commentLength = directory.readUInt16LE(cursor + 32);
        const localHeaderOffset = directory.readUInt32LE(cursor + 42);
        const name = directory.toString("utf8", cursor + 46, cursor + 46 + nameLength);
        entries.push({ name, compressedSize, size: entrySize, method, localHeaderOffset });
        cursor += 46 + nameLength + extraLength + commentLength;
      }
      return new ZipArchive(handle, size, entries);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async read(entry: ZipEntry): Promise<Buffer> {
    const header = Buffer.alloc(30);
    await this.handle.read(header, 0, 30, entry.localHeaderOffset);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new ZipFormatError(`damaged entry ${entry.name}`);
    const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const compressed = Buffer.alloc(entry.compressedSize);
    await this.handle.read(compressed, 0, entry.compressedSize, start);
    if (entry.method === 0) return compressed;
    if (entry.method === 8) return inflateRawSync(compressed);
    throw new ZipFormatError(`${entry.name} uses compression method ${entry.method}, which zip tools rarely write`);
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}
