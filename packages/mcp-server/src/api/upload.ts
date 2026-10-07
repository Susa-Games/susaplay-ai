import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** A failed PUT. `status` is `null` when no answer came back (network, timeout). */
export class UploadError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const IDLE_TIMEOUT_MS = 60_000;

/**
 * Only Google Cloud Storage receives a build, or this machine (the Storage
 * emulator, tests). The URL comes from the SusaPlay API; this is a second check
 * so a build is never sent anywhere else.
 */
export function isAllowedUploadUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (LOCAL_HOSTS.has(url.hostname)) return url.protocol === "http:" || url.protocol === "https:";
  return url.protocol === "https:" && (url.hostname === "storage.googleapis.com" || url.hostname.endsWith(".storage.googleapis.com"));
}

/**
 * PUTs a file with a known Content-Length — the signed URL takes a plain
 * upload, not a chunked one, which `fetch` with a stream body would send.
 */
export async function putFile(
  url: string,
  filePath: string,
  contentType: string,
  options: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  const { size } = await stat(filePath);
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;

  await new Promise<void>((resolve, reject) => {
    const request = send(target, {
      method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": size },
      signal: options.signal,
    });
    request.setTimeout(IDLE_TIMEOUT_MS, () => request.destroy(new Error("the upload stalled")));
    request.on("error", (error) => reject(new UploadError(null, error.message)));
    request.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        if (body.length < 2000) body += chunk;
      });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve();
        // Storage answers in XML; only its error code is useful.
        else reject(new UploadError(status, /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? `HTTP ${status}`));
      });
      response.on("error", (error) => reject(new UploadError(null, error.message)));
    });

    let sent = 0;
    const file = createReadStream(filePath);
    file.on("data", (chunk) => {
      sent += chunk.length;
      options.onProgress?.(sent, size);
    });
    file.on("error", (error) => request.destroy(error));
    file.pipe(request);
  });
}
