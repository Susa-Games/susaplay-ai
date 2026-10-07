import type { CallToolResult } from "@modelcontextprotocol/server";

import { ApiError, guidanceFor } from "../api/errors.js";
import { log } from "../log.js";

/** A problem with the tool's input or the local project, explained in plain words. */
export class ToolInputError extends Error {}

export function ok(summary: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: summary }], structuredContent: data };
}

/** Errors come back as a result the model can act on, never as a stack trace. */
export function fail(error: unknown): CallToolResult {
  let text: string;
  if (error instanceof ApiError) {
    text = guidanceFor(error);
  } else if (error instanceof ToolInputError) {
    text = error.message;
  } else {
    log(`unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    text = "The SusaPlay tool failed unexpectedly. Try again; if it persists, report it to SusaPlay.";
  }
  return { isError: true, content: [{ type: "text", text }] };
}
