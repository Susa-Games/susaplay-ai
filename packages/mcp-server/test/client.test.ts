import { describe, expect, it, vi } from "vitest";

import { ApiClient } from "../src/api/client.js";
import { ApiError, guidanceFor } from "../src/api/errors.js";
import { readConfig } from "../src/config.js";
import { cleanText } from "../src/text.js";

const config = { apiKey: "spdk_secret_value", apiBaseUrl: "https://api.test" };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function client(responses: Array<Response | Error>, options: { clientName?: string } = {}) {
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => undefined);
  const api = new ApiClient(config, { fetch, sleep, clientName: () => options.clientName });
  return { api, fetch, sleep };
}

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected an ApiError");
}

describe("ApiClient", () => {
  it("sends the key and a User-Agent naming the server and the client", async () => {
    const { api, fetch } = client([json(200, { success: true, data: { games: [] } })], { clientName: "claude-code" });
    await expect(api.get("/catalog/games", { days: 7, gameId: undefined })).resolves.toEqual({ games: [] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/catalog/games?days=7");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("ApiKey spdk_secret_value");
    expect(headers["User-Agent"]).toMatch(/^susaplay-mcp\/\S+ \(claude-code\)$/);
  });

  it("maps an error envelope to its stable code and keeps requiredScope", async () => {
    const { api } = client([
      json(403, {
        success: false,
        error: { code: "INSUFFICIENT_SCOPE", message: "This API key does not hold the games:read scope", requiredScope: "games:read" },
      }),
    ]);
    const error = await caught(api.get("/catalog/games"));
    expect(error.code).toBe("INSUFFICIENT_SCOPE");
    expect(error.details.requiredScope).toBe("games:read");
    expect(guidanceFor(error)).toContain("games:read");
  });

  it("waits out a short Retry-After and tries again", async () => {
    const { api, sleep } = client([
      json(429, { success: false, error: { code: "RATE_LIMITED" } }, { "Retry-After": "4" }),
      json(200, { success: true, data: { ok: true } }),
    ]);
    await expect(api.get("/x")).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(4000);
  });

  it("reports a long Retry-After instead of waiting it out", async () => {
    const { api, sleep } = client([json(429, { success: false }, { "Retry-After": "120" })]);
    const error = await caught(api.get("/x"));
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.details.retryAfterSeconds).toBe(120);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a read after a gateway error or a network failure, but never a write", async () => {
    const reads = client([json(503, {}), new TypeError("fetch failed"), json(200, { success: true, data: 1 })]);
    await expect(reads.api.get("/x")).resolves.toBe(1);
    expect(reads.fetch).toHaveBeenCalledTimes(3);

    const writes = client([new TypeError("fetch failed")]);
    expect((await caught(writes.api.post("/x", {}))).code).toBe("NETWORK");
    expect(writes.fetch).toHaveBeenCalledTimes(1);
  });

  it("never calls the API without a key, and never puts the key in an error", async () => {
    const fetch = vi.fn();
    const api = new ApiClient({ apiKey: null, apiBaseUrl: "https://api.test" }, { fetch });
    const error = await caught(api.get("/x"));
    expect(error.code).toBe("NO_API_KEY");
    expect(fetch).not.toHaveBeenCalled();

    const failing = client([json(401, { success: false, error: { code: "UNAUTHENTICATED", message: "Invalid API key" } })]);
    const unauthenticated = await caught(failing.api.get("/x"));
    expect(`${unauthenticated.message} ${guidanceFor(unauthenticated)}`).not.toContain("spdk_secret_value");
  });

  it("names an unknown failure by its HTTP status when the body is not JSON", async () => {
    const { api } = client([new Response("<html>bad gateway</html>", { status: 500 })]);
    expect((await caught(api.get("/x"))).code).toBe("HTTP_500");
  });
});

describe("readConfig", () => {
  it("defaults to the public API and treats a blank key as missing", () => {
    expect(readConfig({ SUSAPLAY_API_KEY: "  " })).toEqual({ apiKey: null, apiBaseUrl: "https://api.susaplay.com" });
  });

  it("accepts HTTPS, or plain HTTP only to this machine", () => {
    expect(readConfig({ SUSAPLAY_API_BASE_URL: "http://localhost:5001/" }).apiBaseUrl).toBe("http://localhost:5001");
    expect(() => readConfig({ SUSAPLAY_API_BASE_URL: "http://api.example.com" })).toThrow(/https/);
  });
});

describe("cleanText", () => {
  it("strips control and direction-override characters and cuts long text", () => {
    expect(cleanText("Space\u0000 Run‮\nnow")).toBe("Space Run now");
    expect(cleanText("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
    expect(cleanText("   ")).toBeNull();
    expect(cleanText(42)).toBeNull();
  });
});
