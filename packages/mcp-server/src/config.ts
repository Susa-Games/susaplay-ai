export const DEFAULT_API_BASE_URL = "https://api.susaplay.com";

export interface Config {
  /** `null` when not set: local tools still work, API tools explain where to set it. */
  apiKey: string | null;
  apiBaseUrl: string;
}

/**
 * Reads the environment. `SUSAPLAY_API_BASE_URL` exists only for internal
 * testing against staging; it must be HTTPS, or plain HTTP to this machine.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawKey = env.SUSAPLAY_API_KEY?.trim() || null;
  // A plugin setting left empty can arrive as its unexpanded placeholder,
  // such as "${user_config.api_key}": that is no key, not a wrong one.
  const apiKey = rawKey && /^\$\{[^}]*\}$/.test(rawKey) ? null : rawKey;
  const raw = env.SUSAPLAY_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SUSAPLAY_API_BASE_URL is not a URL: ${raw}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("SUSAPLAY_API_BASE_URL must use https:// (plain http:// only for localhost)");
  }
  return { apiKey, apiBaseUrl: url.origin + url.pathname.replace(/\/+$/, "") };
}
