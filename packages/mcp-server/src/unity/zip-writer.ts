import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable, pipeline } from "node:stream";
import { createDeflateRaw } from "node:zlib";

/**
 * Writes a build folder to a zip on disk, one file at a time, so a build of
 * hundreds of megabytes never sits in memory. Each local header is written as a
 * placeholder and filled in once the file's CRC and sizes are known — no data
 * descriptors, which some readers handle badly. No ZIP64: an upload is capped
 * at 500 MB and 1000 entries.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return ~crc >>> 0;
}

// Already compressed: deflating them again costs time and saves nothing.
const STORED = /\.(br|gz|zip|bundle|png|jpe?g|webp|mp3|ogg|mp4|webm)$/i;
const UTF8_NAMES = 0x0800;
// 1980-01-01 00:00, the earliest DOS date: a fixed timestamp keeps zips reproducible.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const MAX_OFFSET = 0xffffffff;

export interface ZipInput {
  /** The name inside the zip, with forward slashes. */
  name: string;
  /** The file on disk. */
  path: string;
}

export class ZipTooLargeError extends Error {}

function localHeader(name: Buffer, method: number, crc: number, compressed: number, size: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_NAMES, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name]);
}

function centralHeader(name: Buffer, method: number, crc: number, compressed: number, size: number, offset: number): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_NAMES, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressed, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

/** Writes `files` to `target` and returns the zip's size in bytes. */
export async function writeZip(
  target: string,
  files: ZipInput[],
  onFile?: (done: number, total: number) => void | Promise<void>,
): Promise<number> {
  const handle = await open(target, "w");
  try {
    const central: Buffer[] = [];
    let offset = 0;
    const write = async (chunk: Buffer) => {
      if (offset + chunk.length > MAX_OFFSET) throw new ZipTooLargeError("the zip would exceed 4 GB");
      await handle.write(chunk, 0, chunk.length, offset);
      offset += chunk.length;
    };

    for (const [index, file] of files.entries()) {
      const name = Buffer.from(file.name, "utf8");
      const method = STORED.test(file.name) ? 0 : 8;
      const headerOffset = offset;
      await write(localHeader(name, method, 0, 0, 0));

      let crc = 0;
      let size = 0;
      const counted = Readable.from(
        (async function* () {
          for await (const chunk of createReadStream(file.path)) {
            const bytes = chunk as Buffer;
            crc = crc32(bytes, crc);
            size += bytes.length;
            yield bytes;
          }
        })(),
      );
      let output: Readable = counted;
      if (method === 8) {
        const deflate = createDeflateRaw({ level: 6 });
        // An error on either side destroys the deflate stream, which ends the loop below.
        pipeline(counted, deflate, () => undefined);
        output = deflate;
      }
      const dataStart = offset;
      for await (const chunk of output) await write(chunk as Buffer);
      const compressed = offset - dataStart;

      await handle.write(localHeader(name, method, crc, compressed, size), 0, 30 + name.length, headerOffset);
      central.push(centralHeader(name, method, crc, compressed, size, headerOffset));
      await onFile?.(index + 1, files.length);
    }

    const directory = Buffer.concat(central);
    const directoryOffset = offset;
    await write(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(directoryOffset, 16);
    await write(end);
    return offset;
  } finally {
    await handle.close();
  }
}
