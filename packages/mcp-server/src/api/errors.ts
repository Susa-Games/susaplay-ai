/** An API failure, carrying the server's stable `code`. Never carries the key. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: { requiredScope?: string; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const KEY_HELP =
  "Create a key in the SusaPlay Developer Portal under API Keys (the \"AI assistant\" preset is recommended) " +
  "and set it as SUSAPLAY_API_KEY in this MCP server's configuration — in Claude Code, the SusaPlay plugin's " +
  "settings; in Cursor, Settings → MCP.";

/**
 * What to tell the model, keyed by the server's error `code` — never by its
 * message, which is free text and may change. The server's message is passed
 * along as data where it carries the specifics (a version number, a field).
 */
export function guidanceFor(error: ApiError): string {
  const detail = error.message ? ` SusaPlay said: "${error.message}"` : "";
  switch (error.code) {
    case "NO_API_KEY":
      return `No SusaPlay API key is set. ${KEY_HELP}`;
    case "UNAUTHENTICATED":
      return `SusaPlay did not accept the API key: it is wrong, revoked, or from before October 2026. ${KEY_HELP}`;
    case "INSUFFICIENT_SCOPE":
      return (
        `This API key does not have the ${error.details.requiredScope ?? "required"} permission. ` +
        "Create a key that has it in the Developer Portal under API Keys, and replace SUSAPLAY_API_KEY."
      );
    case "UNAUTHORIZED":
      return `Not allowed: the game belongs to another developer, or the developer account is suspended.${detail}`;
    case "NOT_FOUND":
      return `Not found.${detail} Use list_games to see the games this key can reach.`;
    case "INVALID_ARGUMENT":
      return `The request was refused.${detail}`;
    case "DUPLICATE":
      return `That version already exists.${detail} Use a new version number.`;
    case "FAILED_PRECONDITION":
      return `SusaPlay cannot do this right now.${detail}`;
    case "RATE_LIMITED":
      return (
        `Too many requests with this API key. Wait ${error.details.retryAfterSeconds ?? 60} seconds before trying ` +
        "again, and avoid calling tools in a loop."
      );
    case "ANALYTICS_UNAVAILABLE":
      return "Analytics is temporarily unavailable. Try again in a few minutes.";
    case "NETWORK":
      return `Could not reach SusaPlay.${detail} Check the internet connection and try again.`;
    case "TIMEOUT":
      return "SusaPlay did not answer in time. Try again in a moment.";
    default:
      return `SusaPlay returned an error (${error.code}).${detail} Try again later; if it persists, report it to SusaPlay.`;
  }
}
