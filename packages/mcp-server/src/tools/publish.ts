import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/errors.js";
import { UploadError, isAllowedUploadUrl, putFile } from "../api/upload.js";
import { cleanText } from "../text.js";
import { type BuildSource, openBuild } from "../unity/build-source.js";
import { writeZip } from "../unity/zip-writer.js";
import type { Finding } from "./check-project.js";
import type { ApiVersion, RetentionPolicy } from "./games.js";
import { MAX_ZIP_BYTES, inspectBuild } from "./inspect-build.js";
import { ToolInputError, fail, ok } from "./result.js";
import { type ApiGame, gameIdSchema } from "./shared.js";

// The server's version format (catalog_api/common.py VERSION_PATTERN).
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+)?$/;
const IN_FLIGHT = new Set(["processing", "extracting"]);
const IN_REVIEW = new Set(["pending_review", "processing", "extracting"]);
const POLL_LIMIT_MS = 15 * 60 * 1000;
const POLL_FIRST_MS = 2000;
const POLL_MAX_MS = 10_000;
const PLAYER_PORTAL = "https://susaplay.com";
const STAGING_PLAYER_PORTAL = "https://susaplay-player-staging.web.app";

const MB = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export const versionIdSchema = z
  .string()
  .regex(VERSION_PATTERN, "A version is x.y.z, such as 1.0.9, optionally with a suffix such as 1.0.9-beta")
  .describe("The new build's version, x.y.z — higher than the game's latest");

/** Reports progress to the client, when it asked for it. */
export type Progress = (progress: number, total: number | undefined, message: string) => Promise<void>;

export interface PublishDependencies {
  api: ApiClient;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  progress?: Progress;
  signal?: AbortSignal;
}

export interface PublishResult {
  gameId: string;
  versionId: string;
  status: string;
  failure: { code: string | null; message: string | null } | null;
  fileCount: number;
  zipBytes: number;
  prunedVersions: string[];
  findings: Finding[];
  nextStep: string;
}

/** The version after the highest one, for a duplicate: 1.0.8 and 1.0.10 suggest 1.0.11. */
export function nextPatchVersion(versionIds: string[]): string | null {
  const parsed = versionIds
    .map((id) => /^([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(id))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [Number(match[1]), Number(match[2]), Number(match[3])] as const)
    .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  const top = parsed[0];
  return top ? `${top[0]}.${top[1]}.${top[2] + 1}` : null;
}

/** Where a preview link opens: the player portal of the API's environment. */
export function playerPortalBase(apiBaseUrl: string): string {
  const host = new URL(apiBaseUrl).hostname;
  return host.includes("susaplaytest") || host.includes("staging") ? STAGING_PLAYER_PORTAL : PLAYER_PORTAL;
}

function versionPath(gameId: string, versionId: string): string {
  return `/catalog/game/${encodeURIComponent(gameId)}/versions/${encodeURIComponent(versionId)}`;
}

function inReviewList(versions: ApiVersion[]): string {
  return versions
    .filter((version) => IN_REVIEW.has(version.status ?? ""))
    .map((version) => `${version.versionId} (${version.status})`)
    .join(", ");
}

/** Everything but the build itself: the zip the server will receive, from a folder. */
async function zipFolder(build: BuildSource, target: string, progress: Progress): Promise<number> {
  const names = [...build.files.keys()].sort();
  return writeZip(
    target,
    names.map((name) => ({ name, path: join(build.path, build.prefix, name) })),
    (done, total) => progress(done, total, `Zipping ${done}/${total} files`),
  );
}

async function upload(
  api: ApiClient,
  gameId: string,
  versionId: string,
  zipPath: string,
  progress: Progress,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    // Signed only now that the zip exists, so zipping does not use up the URL's 20 minutes.
    const signed = await api.post<{ uploadUrl: string }>("/catalog/get-upload-url", { gameId, versionId, platform: "webgl" });
    if (!isAllowedUploadUrl(signed.uploadUrl)) {
      throw new ApiError("SIGNED_URL_UNAVAILABLE", "the upload URL is not a Cloud Storage URL", 0);
    }
    let reported = -1;
    try {
      await putFile(signed.uploadUrl, zipPath, "application/zip", {
        signal,
        onProgress: (sent, total) => {
          const percent = Math.floor((sent / total) * 100);
          if (percent === reported) return;
          reported = percent;
          void progress(sent, total, `Uploading ${MB(sent)} of ${MB(total)}`);
        },
      });
      return;
    } catch (error) {
      if (signal?.aborted) throw new ToolInputError("The upload was cancelled. Nothing was published.");
      const retryable = error instanceof UploadError && (error.status === null || error.status === 408 || error.status >= 500);
      // One retry, with a fresh URL, after a network failure.
      if (retryable && attempt === 0) continue;
      if (error instanceof UploadError) {
        throw new ToolInputError(`The upload to storage failed (${error.message}). Nothing was published; try again.`);
      }
      throw error;
    }
  }
}

export async function publishBuild(
  input: { gameId: string; versionId: string; buildPath: string; notes?: string; serverDataPath?: string },
  deps: PublishDependencies,
): Promise<PublishResult> {
  const { api, gameId, versionId } = { ...deps, ...input };
  const sleep = deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const now = deps.now ?? Date.now;
  const progress: Progress = deps.progress ?? (async () => undefined);
  const gamePath = `/catalog/game/${encodeURIComponent(gameId)}`;

  // 1. The same checks as inspect_build; any error stops here, before anything is sent.
  const build = await openBuild(input.buildPath);
  let tempDir: string | null = null;
  try {
    const report = await inspectBuild(build, { gameId, serverDataPath: input.serverDataPath, api, fetch: deps.fetch });
    if (!report.passed) {
      const errors = report.findings.filter((finding) => finding.severity === "error");
      throw new ToolInputError(
        `Not published: the build has ${errors.length} problem(s). Fix them and rebuild:\n` +
          errors.map((finding) => `- ${finding.id}: ${finding.message}`).join("\n"),
      );
    }

    // What the server would refuse anyway, found before minutes of zipping and uploading.
    const [{ retention }, { versions: before = [] }] = await Promise.all([
      api.get<{ game: ApiGame; retention?: RetentionPolicy }>(gamePath),
      api.get<{ versions: ApiVersion[] }>(`${gamePath}/versions`),
    ]);
    const existing = before.find((version) => version.versionId === versionId);
    if (existing && existing.status !== "failed") {
      const next = nextPatchVersion(before.map((version) => version.versionId));
      throw new ToolInputError(`Version ${versionId} already exists (${existing.status}).${next ? ` Use ${next}.` : ""}`);
    }
    const inReview = before.filter((version) => IN_REVIEW.has(version.status ?? ""));
    // Without the policy (an older API), the server's own check at get-upload-url still applies.
    if (retention && inReview.length >= retention.maxPendingPerGame) {
      throw new ToolInputError(
        `This game already has ${inReview.length} builds waiting for review or processing: ${inReviewList(before)}. ` +
          `At most ${retention.maxPendingPerGame} are allowed. Wait for a review, or remove one in the Developer Portal.`,
      );
    }

    // 2. The zip: a folder is zipped to a temporary file; a zip is uploaded as it is.
    let zipPath = build.path;
    let zipBytes = build.zippedBytes ?? 0;
    if (build.kind === "folder") {
      tempDir = await mkdtemp(join(tmpdir(), "susaplay-build-zip-"));
      zipPath = join(tempDir, "build.zip");
      zipBytes = await zipFolder(build, zipPath, progress);
      if (zipBytes > MAX_ZIP_BYTES) {
        throw new ToolInputError(`Not published: the zipped build is ${MB(zipBytes)}; the limit is 500 MB.`);
      }
    }

    // 3–5. Sign, upload, and hand over for processing.
    try {
      await upload(api, gameId, versionId, zipPath, progress, deps.signal);
      await api.post(`/catalog/process-build`, {
        gameId,
        versionId,
        platform: "webgl",
        ...(input.notes ? { notes: input.notes } : {}),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "DUPLICATE") {
        const next = nextPatchVersion(before.map((version) => version.versionId));
        throw new ToolInputError(`Version ${versionId} already exists.${next ? ` Use ${next}.` : ""}`);
      }
      if (error instanceof ApiError && error.code === "FAILED_PRECONDITION") {
        const listed = inReviewList(before);
        throw new ToolInputError(
          `SusaPlay refused the upload: ${error.message || "too many builds are waiting for review"}${listed ? ` In review or processing: ${listed}.` : ""}`,
        );
      }
      throw error;
    }

    // 6. Wait for the worker: backing off from 2 to 10 seconds, for up to 15 minutes.
    const deadline = now() + POLL_LIMIT_MS;
    let delay = POLL_FIRST_MS;
    let version: ApiVersion = { versionId, status: "processing" };
    while (!deps.signal?.aborted) {
      await progress(0, undefined, `SusaPlay is processing ${versionId}`);
      await sleep(delay);
      if (deps.signal?.aborted) break;
      version = (await api.get<{ version: ApiVersion }>(versionPath(gameId, versionId))).version;
      if (!IN_FLIGHT.has(version.status ?? "") || now() >= deadline) break;
      delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.5));
    }

    // 7. Retention runs after processing; what it removed is what is no longer listed.
    let prunedVersions: string[] = [];
    if (version.status === "pending_review") {
      const { versions: after = [] } = await api.get<{ versions: ApiVersion[] }>(`${gamePath}/versions`);
      const remaining = new Set(after.map((entry) => entry.versionId));
      prunedVersions = before.map((entry) => entry.versionId).filter((id) => id !== versionId && !remaining.has(id));
    }

    const failure = version.failure
      ? { code: version.failure.code ?? null, message: cleanText(version.failure.message, 300) }
      : null;
    const status = version.status ?? "processing";
    const nextStep =
      status === "pending_review"
        ? "The build is waiting for SusaPlay's review; players see it once it is approved. Offer create_preview_link to play it first."
        : status === "failed"
          ? `Processing failed${failure?.message ? `: ${failure.message}` : ""}. Fix the build and publish again — the same version number may be reused.`
          : `Still processing. Check later with get_game ${gameId}; a build stuck for more than 15 minutes is reported as failed and may be uploaded again.`;
    return {
      gameId,
      versionId,
      status,
      failure,
      fileCount: report.fileCount,
      zipBytes,
      prunedVersions,
      findings: report.findings,
      nextStep,
    };
  } finally {
    await build.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

/** Progress notifications for a request whose client sent a progress token. */
function progressFor(ctx: {
  mcpReq: { _meta?: { progressToken?: string | number }; notify: (notification: { method: string; params?: Record<string, unknown> }) => Promise<void> };
}): Progress {
  const token = ctx.mcpReq._meta?.progressToken;
  let step = 0;
  return async (progress, total, message) => {
    if (token === undefined) return;
    // The protocol requires progress to increase with every notification.
    step = Math.max(step + 1, progress);
    await ctx.mcpReq
      .notify({ method: "notifications/progress", params: { progressToken: token, progress: step, ...(total ? { total: Math.max(total, step) } : {}), message } })
      .catch(() => undefined);
  };
}

export function registerPublishTools(
  server: McpServer,
  api: ApiClient,
  cwd: () => string = () => process.cwd(),
  fetchImpl?: typeof fetch,
): void {
  server.registerTool(
    "publish_build",
    {
      title: "Publish a WebGL build for review",
      description:
        "Uploads a Unity WebGL build — its folder or .zip — to SusaPlay as a new version for review. It runs " +
        "inspect_build first and stops on any error, zips a folder, uploads it with progress, and waits up to 15 " +
        "minutes for SusaPlay to process it. Players do not see the build until SusaPlay approves it. Retention " +
        "may delete old builds that are not live or in review — get_game shows which. Use a version number " +
        "higher than the game's latest.",
      inputSchema: z.object({
        gameId: gameIdSchema,
        versionId: versionIdSchema,
        buildPath: z.string().describe("The WebGL build output folder, or its .zip"),
        notes: z.string().max(1000).optional().describe("What changed, for the reviewer"),
        serverDataPath: z
          .string()
          .optional()
          .describe("Addressables content built with this build and published with it, such as ServerData/WebGL"),
      }),
      outputSchema: z.object({
        gameId: z.string(),
        versionId: z.string(),
        status: z.string(),
        failure: z.object({ code: z.string().nullable(), message: z.string().nullable() }).nullable(),
        fileCount: z.number(),
        zipBytes: z.number(),
        prunedVersions: z.array(z.string()),
        findings: z.array(z.object({ id: z.string(), severity: z.enum(["error", "warning", "info"]), message: z.string(), file: z.string().optional() })),
        nextStep: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ gameId, versionId, buildPath, notes, serverDataPath }, ctx) => {
      const absolute = (path: string) => (isAbsolute(path) ? path : resolve(cwd(), path));
      try {
        const result = await publishBuild(
          { gameId, versionId, buildPath: absolute(buildPath), notes, serverDataPath: serverDataPath ? absolute(serverDataPath) : undefined },
          { api, fetch: fetchImpl, progress: progressFor(ctx), signal: ctx.mcpReq.signal },
        );
        const lines = [
          `${result.versionId}: ${result.status}. ${result.fileCount} files, ${MB(result.zipBytes)} zipped.`,
          ...(result.prunedVersions.length ? [`Retention deleted: ${result.prunedVersions.join(", ")}.`] : []),
          ...result.findings.map((finding) => `- ${finding.id} ${finding.severity}: ${finding.message}`),
          result.nextStep,
        ];
        return ok(lines.join("\n"), { ...result });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "create_preview_link",
    {
      title: "Create a preview link for a build in review",
      description:
        "Creates a link to play a build that is waiting for review, on the SusaPlay player site. The link works " +
        "once and expires in 30 minutes; create a new one to play again. Only builds in pending_review can be " +
        "previewed.",
      inputSchema: z.object({ gameId: gameIdSchema, versionId: versionIdSchema.describe("A version in pending_review") }),
      outputSchema: z.object({ gameId: z.string(), versionId: z.string(), url: z.string(), expiresAt: z.string().nullable() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ gameId, versionId }) => {
      try {
        let session: { launchToken: string; expiresAt?: string };
        try {
          session = await api.post(`${versionPath(gameId, versionId)}/preview-session`, {});
        } catch (error) {
          if (error instanceof ApiError && error.code === "NOT_FOUND") {
            throw new ToolInputError(
              `${gameId} has no build ${versionId} waiting for review. Only a pending_review build can be previewed; get_game lists the builds.`,
            );
          }
          throw error;
        }
        const url = `${playerPortalBase(api.baseUrl)}/play/${encodeURIComponent(gameId)}?previewSession=${encodeURIComponent(session.launchToken)}`;
        const expiresAt = typeof session.expiresAt === "string" ? session.expiresAt : null;
        return ok(
          `Preview ${versionId}: ${url}\nThe link works once and expires ${expiresAt ? `at ${expiresAt}` : "in 30 minutes"}. Do not share it; create a new one to play again.`,
          { gameId, versionId, url, expiresAt },
        );
      } catch (error) {
        return fail(error);
      }
    },
  );
}
