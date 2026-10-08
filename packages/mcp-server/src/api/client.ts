import type { Config } from "../config.js";
import { SERVER_VERSION } from "../version.js";
import { ApiError } from "./errors.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  fetch?: FetchLike;
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The MCP client's name, for the User-Agent; read when a request is made. */
  clientName?: () => string | undefined;
}

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
// A Retry-After longer than this is not waited out: the tool reports it.
const MAX_RETRY_AFTER_SECONDS = 30;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/**
 * The only way the server talks to SusaPlay: the public API, with the developer
 * API key. Errors come back as `ApiError` with the API's stable `code`.
 */
export class ApiClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: Config,
    private readonly options: ClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The API's origin and path, for links that depend on the environment. */
  get baseUrl(): string {
    return this.config.apiBaseUrl;
  }

  get hasKey(): boolean {
    return this.config.apiKey !== null;
  }

  get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) params.set(name, String(value));
    }
    const suffix = params.size ? `?${params}` : "";
    return this.request<T>("GET", `${path}${suffix}`);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private userAgent(): string {
    const client = this.options.clientName?.();
    return `susaplay-mcp/${SERVER_VERSION}${client ? ` (${client.replace(/[^\w .-]/g, "").slice(0, 40)})` : ""}`;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (!this.config.apiKey) {
      throw new ApiError("NO_API_KEY", "", 0);
    }
    const url = `${this.config.apiBaseUrl}${path}`;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `ApiKey ${this.config.apiKey}`,
            "User-Agent": this.userAgent(),
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        // Only a read is retried after a network failure: a write may have landed.
        if (method === "GET" && attempt < MAX_RETRIES) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new ApiError(timedOut ? "TIMEOUT" : "NETWORK", "", 0);
      }

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
        if (attempt < MAX_RETRIES && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
          await this.sleep(retryAfter * 1000);
          continue;
        }
        throw new ApiError("RATE_LIMITED", "", 429, { retryAfterSeconds: retryAfter });
      }
      if (method === "GET" && RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      return parseEnvelope<T>(response);
    }
  }
}

function parseRetryAfter(value: string | null): number {
  const seconds = Number.parseInt(value ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
}

async function parseEnvelope<T>(response: Response): Promise<T> {
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  const envelope = (json ?? {}) as {
    success?: boolean;
    data?: T;
    error?: { code?: string; message?: string; requiredScope?: string; compatibility?: unknown } | string;
  };
  if (response.ok && envelope.success && envelope.data !== undefined) {
    return envelope.data;
  }
  const error = typeof envelope.error === "object" && envelope.error ? envelope.error : {};
  const code = error.code || (response.status === 404 ? "NOT_FOUND" : response.ok ? "INTERNAL" : `HTTP_${response.status}`);
  const message = typeof envelope.error === "string" ? envelope.error : (error.message ?? "");
  // An INCOMPATIBLE_CATALOG refusal names every failed check; keep them all.
  const limit = error.compatibility ? 2000 : 300;
  throw new ApiError(code, message.slice(0, limit), response.status, {
    requiredScope: error.requiredScope,
    compatibility: error.compatibility,
  });
}
