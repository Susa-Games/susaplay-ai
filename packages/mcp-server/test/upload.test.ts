import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UploadError, isAllowedUploadUrl, putFile } from "../src/api/upload.js";

const dir = mkdtempSync(join(tmpdir(), "susaplay-upload-"));
const file = join(dir, "build.zip");
const content = Buffer.alloc(300_000, 7);
writeFileSync(file, content);

let storage: Server;
let base: string;
const received: Array<{ headers: Record<string, unknown>; body: Buffer }> = [];

beforeAll(async () => {
  storage = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks) });
      if (request.url === "/expired") {
        response.writeHead(403, { "Content-Type": "application/xml" });
        response.end("<Error><Code>ExpiredToken</Code><Message>expired</Message></Error>");
        return;
      }
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise<void>((resolve) => storage.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(storage.address() as AddressInfo).port}`;
});

afterAll(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("putFile", () => {
  it("sends the file with its length and content type, reporting progress", async () => {
    const progress: number[] = [];
    await putFile(`${base}/ok`, file, "application/zip", { onProgress: (sent) => progress.push(sent) });
    const last = received.at(-1)!;
    expect(last.headers["content-type"]).toBe("application/zip");
    expect(last.headers["content-length"]).toBe(String(content.length));
    expect(last.headers["transfer-encoding"]).toBeUndefined();
    expect(last.body.equals(content)).toBe(true);
    expect(progress.at(-1)).toBe(content.length);
  });

  it("reports Storage's error code", async () => {
    const error = await putFile(`${base}/expired`, file, "application/zip").catch((caught) => caught);
    expect(error).toBeInstanceOf(UploadError);
    expect(error).toMatchObject({ status: 403, message: "ExpiredToken" });
  });

  it("reports a network failure without a status", async () => {
    const error = await putFile("http://127.0.0.1:1/x", file, "application/zip").catch((caught) => caught);
    expect(error).toBeInstanceOf(UploadError);
    expect(error.status).toBeNull();
  });
});

describe("isAllowedUploadUrl", () => {
  it("accepts Cloud Storage over HTTPS and this machine only", () => {
    expect(isAllowedUploadUrl("https://storage.googleapis.com/bucket/games/x?X-Goog-Signature=1")).toBe(true);
    expect(isAllowedUploadUrl("https://bucket.storage.googleapis.com/x")).toBe(true);
    expect(isAllowedUploadUrl("http://127.0.0.1:9199/x")).toBe(true);
    expect(isAllowedUploadUrl("http://storage.googleapis.com/x")).toBe(false);
    expect(isAllowedUploadUrl("https://storage.googleapis.com.evil.test/x")).toBe(false);
    expect(isAllowedUploadUrl("https://example.com/x")).toBe(false);
    expect(isAllowedUploadUrl("not a url")).toBe(false);
  });
});
