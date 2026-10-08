import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/errors.js";
import { UploadError, isAllowedUploadUrl, putFile } from "../api/upload.js";
import { type CatalogBundle, CatalogFormatError, readCatalogBundles } from "../unity/catalog.js";
import type { ApiAddressables } from "./addressables.js";
import { type Progress, progressFor } from "./publish.js";
import { ToolInputError, fail, ok } from "./result.js";
import { gameIdSchema, num, str } from "./shared.js";

const DEFAULT_BASE = "https://games.susaplay.com/addressables/";
// The server's limits (catalog_api/addressables.py).
const BATCH_FILES = 250;
const MAX_FILES = 1500;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const PARALLEL_UPLOADS = 6;
const UPLOAD_RETRIES = 3;

const MB = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** One file the upload sends or reuses. */
interface LocalFile {
  filename: string;
  path: string;
  sizeBytes: number;
}

/** What a content folder holds for one catalog: the pair and the remote bundles it names. */
export interface ContentSet {
  catalog: string;
  files: LocalFile[];
  /** Files in the folder this catalog does not use — older builds' bundles and catalogs. */
  ignored: string[];
}

export interface UploadDependencies {
  api: ApiClient;
  sleep?: (ms: number) => Promise<void>;
  progress?: Progress;
  signal?: AbortSignal;
}

export interface UploadResult {
  gameId: string;
  dryRun: boolean;
  catalog: string;
  fileCount: number;
  totalBytes: number;
  uploaded: number;
  uploadedBytes: number;
  reused: number;
  ignored: string[];
  readyToPublish: boolean;
  staging: { fileCount: number; totalBytes: number; maxFiles: number; maxBytes: number };
  nextStep: string;
}

/**
 * Picks the catalog and the files that belong to it. Unity's ServerData folder
 * keeps the bundles of every earlier content build, so the folder is never
 * uploaded as it is: only the catalog pair and the remote bundles the catalog
 * names, all of which must be there.
 */
/** `remoteBase` is the game's Remote Load Path, as the API gives it. */
export async function readContentSet(dir: string, remoteBase: string, catalog?: string): Promise<ContentSet> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    throw new ToolInputError(`serverDataPath ${dir} is not a folder. Pass the Addressables build output, such as ServerData/WebGL.`);
  }
  if (names.some((name) => /^catalog_.+\.json$/.test(name)) && !names.some((name) => /^catalog_.+\.bin$/.test(name))) {
    throw new ToolInputError(
      "The catalog is JSON; SusaPlay accepts only a binary catalog (catalog_*.bin). Run check_project — finding SP015 says how to switch.",
    );
  }
  const catalogs = names.filter((name) => /^catalog_.+\.bin$/.test(name));
  let chosen: string;
  if (catalog) {
    chosen = catalog.endsWith(".bin") ? catalog : `${catalog.replace(/\.hash$/, "")}.bin`;
    if (!catalogs.includes(chosen)) {
      throw new ToolInputError(`${chosen} is not in ${dir}. It has: ${catalogs.join(", ") || "no binary catalog"}.`);
    }
  } else if (catalogs.length === 1) {
    chosen = catalogs[0]!;
  } else if (catalogs.length === 0) {
    throw new ToolInputError(`No binary catalog (catalog_*.bin) in ${dir}. Build the Addressables content first.`);
  } else {
    throw new ToolInputError(
      `${dir} has several catalogs: ${catalogs.join(", ")}. Pass catalog with the one the live build requests ` +
        "(inspect_build shows it), or the one from the content build you mean to publish.",
    );
  }
  const hash = chosen.replace(/\.bin$/, ".hash");
  if (!names.includes(hash)) throw new ToolInputError(`${hash} is missing next to ${chosen}. Rebuild the Addressables content.`);

  let bundles: CatalogBundle[];
  try {
    bundles = readCatalogBundles(await readFile(join(dir, chosen)));
  } catch (error) {
    if (error instanceof CatalogFormatError) throw new ToolInputError(`${chosen} could not be read as an Addressables binary catalog: ${error.message}`);
    throw error;
  }

  // The server refuses this at publish (C3); found here before anything is uploaded.
  const base = remoteBase;
  const remote = bundles.filter((bundle) => !bundle.local);
  const elsewhere = remote.filter((bundle) => !bundle.internalId.startsWith(base) || bundle.internalId.includes("{"));
  if (elsewhere.length) {
    throw new ToolInputError(
      `Not uploaded: ${elsewhere.length} remote bundle(s) load from somewhere other than ${base}, for example ` +
        `${elsewhere[0]!.internalId}. Set the Remote Load Path to ${base} (check_project, SP010) and rebuild the content.`,
    );
  }
  const wanted = [...new Set(remote.map((bundle) => bundle.fileName))].sort();
  const missing = wanted.filter((name) => !names.includes(name));
  if (missing.length) {
    throw new ToolInputError(
      `${chosen} names ${missing.length} bundle(s) that are not in ${dir}: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}. Rebuild the Addressables content.`,
    );
  }

  const files: LocalFile[] = [];
  for (const filename of [hash, chosen, ...wanted]) {
    const path = join(dir, filename);
    files.push({ filename, path, sizeBytes: (await stat(path)).size });
  }
  const used = new Set(files.map((file) => file.filename));
  const ignored = names.filter((name) => !used.has(name) && (name.endsWith(".bundle") || /^catalog_/.test(name)));
  return { catalog: chosen, files, ignored };
}

async function inBatches<T>(items: T[], size: number, run: (batch: T[]) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += size) await run(items.slice(start, start + size));
}

/** Runs `task` on every item, at most `limit` at a time; the first failure stops the rest. */
async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await task(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

interface SignedUpload {
  filename: string;
  uploadUrl: string;
  headers?: Record<string, string>;
}

async function putWithRetries(
  upload: SignedUpload,
  file: LocalFile,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!isAllowedUploadUrl(upload.uploadUrl)) {
    throw new ApiError("SIGNED_URL_UNAVAILABLE", "the upload URL is not a Cloud Storage URL", 0);
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await putFile(upload.uploadUrl, file.path, upload.headers?.["Content-Type"] ?? "application/octet-stream", { signal });
      return;
    } catch (error) {
      if (signal?.aborted) throw new ToolInputError("The upload was cancelled. Staging may hold part of the content; players see nothing.");
      const retryable = error instanceof UploadError && (error.status === null || error.status === 408 || error.status === 429 || error.status >= 500);
      if (retryable && attempt < UPLOAD_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (error instanceof UploadError) {
        throw new ToolInputError(`Uploading ${file.filename} failed (${error.message}). Players see nothing; run upload_addressables again — files already sent are skipped.`);
      }
      throw error;
    }
  }
}

export async function uploadAddressables(
  input: { gameId: string; serverDataPath: string; catalog?: string; dryRun?: boolean },
  deps: UploadDependencies,
): Promise<UploadResult> {
  const { api, gameId } = { ...deps, ...input };
  const sleep = deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const progress: Progress = deps.progress ?? (async () => undefined);
  const base = `/catalog/game/${encodeURIComponent(gameId)}/addressables`;

  const state = await api.get<ApiAddressables>(base);
  if (!state.enabled) {
    throw new ToolInputError(`Addressables are not enabled for ${gameId}. Enable them in the Developer Portal on the game's Addressables tab.`);
  }
  if (state.status === "suspended") {
    throw new ToolInputError(`SusaPlay has suspended ${gameId}'s Addressables; uploading is blocked. The Developer Portal shows the reason.`);
  }

  const remoteBase = str(state.remoteLoadPath) ?? `${DEFAULT_BASE}${gameId}/`;
  const content = await readContentSet(input.serverDataPath, remoteBase, input.catalog);
  const totalBytes = content.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (content.files.length > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
    throw new ToolInputError(
      `Not uploaded: the content is ${content.files.length} files and ${MB(totalBytes)}; a release holds at most ${MAX_FILES} files and 5 GB.`,
    );
  }
  // Publishing ships everything in staging, so staging must hold nothing but this content.
  const names = new Set(content.files.map((file) => file.filename));
  const stale = (state.staging ?? []).map((file) => file.filename ?? "").filter((name) => name && !names.has(name));
  if (stale.length) {
    throw new ToolInputError(
      `Not uploaded: staging already holds ${stale.length} file(s) that are not part of this content, from an earlier ` +
        `upload: ${stale.slice(0, 5).join(", ")}${stale.length > 5 ? ", …" : ""}. Publishing would ship them too. ` +
        "Delete them in the Developer Portal (the game's Addressables tab), then upload again.",
    );
  }

  const live = new Set((state.live ?? []).map((file) => file.filename ?? ""));
  let uploaded = 0;
  let uploadedBytes = 0;
  let reused = 0;
  if (input.dryRun) {
    reused = content.files.filter((file) => file.filename.endsWith(".bundle") && live.has(file.filename)).length;
  } else {
    const byName = new Map(content.files.map((file) => [file.filename, file]));
    let done = 0;
    // Signed and sent one batch at a time, so no URL waits out its 20 minutes.
    await inBatches(content.files, BATCH_FILES, async (batch) => {
      const signed = await api.post<{ uploads?: SignedUpload[]; reused?: Array<{ filename: string }> }>(`${base}/upload-batch`, {
        files: batch.map((file) => ({ filename: file.filename, sizeBytes: file.sizeBytes })),
      });
      reused += (signed.reused ?? []).length;
      done += (signed.reused ?? []).length;
      await pool(signed.uploads ?? [], PARALLEL_UPLOADS, async (upload) => {
        const file = byName.get(upload.filename);
        if (!file) throw new ApiError("INTERNAL", `the API signed ${upload.filename}, which was not asked for`, 0);
        await putWithRetries(upload, file, sleep, deps.signal);
        uploaded += 1;
        uploadedBytes += file.sizeBytes;
        done += 1;
        await progress(done, content.files.length, `Uploaded ${done}/${content.files.length} files (${MB(uploadedBytes)})`);
      });
      const registered = await api.post<{ missing?: string[] }>(`${base}/register-batch`, {
        files: batch.map((file) => ({ filename: file.filename })),
      });
      if (registered.missing?.length) {
        throw new ToolInputError(
          `SusaPlay did not receive ${registered.missing.join(", ")}. Players see nothing; run upload_addressables again.`,
        );
      }
    });
  }

  const after = input.dryRun ? state : await api.get<ApiAddressables>(base);
  const staged = after.staging ?? [];
  const readyToPublish = input.dryRun ? true : Boolean(after.stagingReadiness?.readyToPublish);
  return {
    gameId,
    dryRun: Boolean(input.dryRun),
    catalog: content.catalog,
    fileCount: content.files.length,
    totalBytes,
    uploaded,
    uploadedBytes,
    reused,
    ignored: content.ignored,
    readyToPublish,
    staging: {
      fileCount: input.dryRun ? content.files.length : staged.length,
      totalBytes: input.dryRun ? totalBytes : staged.reduce((sum, file) => sum + (num(file.sizeBytes) ?? 0), 0),
      maxFiles: MAX_FILES,
      maxBytes: MAX_TOTAL_BYTES,
    },
    nextStep: input.dryRun
      ? "Nothing was uploaded. Run upload_addressables without dryRun to stage this content."
      : readyToPublish
        ? "Staged; players see nothing yet. Run plan_addressables_publish and show the developer the plan before publishing."
        : "Staged, but staging is not ready to publish — get_addressables says what is missing.",
  };
}

const checkSchema = z.object({ id: z.string(), status: z.string(), message: z.string() });
const compatibilitySchema = z.object({
  compatible: z.boolean(),
  liveBuild: z.string().nullable(),
  requestedCatalog: z.string().nullable(),
  checks: z.array(checkSchema),
});
type Compatibility = z.infer<typeof compatibilitySchema>;

interface ApiCompatibility {
  compatible?: boolean;
  liveBuild?: string | null;
  requestedCatalog?: string | null;
  checks?: Array<{ id?: string; status?: string; message?: string }>;
}

function readCompatibility(raw: ApiCompatibility | null | undefined): Compatibility {
  return {
    compatible: Boolean(raw?.compatible),
    liveBuild: str(raw?.liveBuild),
    requestedCatalog: str(raw?.requestedCatalog),
    checks: (raw?.checks ?? []).map((check) => ({ id: check.id ?? "?", status: check.status ?? "?", message: check.message ?? "" })),
  };
}

function describeChecks(compatibility: Compatibility): string[] {
  return [
    `Checked against the live build ${compatibility.liveBuild ?? "(none yet)"}: ${compatibility.compatible ? "compatible" : "WOULD BREAK THE GAME"}.`,
    ...compatibility.checks.map((check) => `- ${check.id} ${check.status}: ${check.message}`),
  ];
}

const listSummary = (label: string, files: string[]) =>
  files.length ? `${label}: ${files.length} (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""})` : `${label}: none`;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const numbers = (value: unknown): number[] => (Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : []);

/** An INCOMPATIBLE_CATALOG refusal, with every failed check. */
function refusal(error: unknown): never {
  if (error instanceof ApiError && error.code === "INCOMPATIBLE_CATALOG" && error.details.compatibility) {
    const compatibility = readCompatibility(error.details.compatibility as ApiCompatibility);
    throw new ToolInputError(
      [
        "Refused, and nothing changed: this content would break the game's live build.",
        ...describeChecks(compatibility),
        "Usually the content was built with other settings than the live build — another Remote Load Path or Player " +
          "Version Override, or a group switched between local and remote. Rebuild it from the same project and profile " +
          "as the live build, or publish a new build first.",
      ].join("\n"),
    );
  }
  throw error;
}

const releaseIdSchema = z
  .string()
  .regex(/^[0-9]{1,9}$/, "A release ID is a number such as \"3\" — get_addressables lists them")
  .describe("The release to restore, from get_addressables, such as \"3\"");

const expectedLiveSchema = z
  .string()
  .regex(/^[0-9]{1,9}$/)
  .nullable()
  .describe("The live release when the plan was made, exactly as the plan returned it; null if the game had no release");

export function registerAddressablesPublishTools(
  server: McpServer,
  api: ApiClient,
  cwd: () => string = () => process.cwd(),
): void {
  server.registerTool(
    "upload_addressables",
    {
      title: "Upload Addressables content to staging",
      description:
        "Uploads a Unity Addressables content build — the platform folder holding the catalog, such as " +
        "ServerData/WebGL — to the game's staging. Players see nothing until it is published. Only the catalog " +
        "pair and the remote bundles the catalog names are sent; bundles SusaPlay already has are skipped, and " +
        "older builds' files left in the folder are ignored. Refuses when staging holds files from another upload. " +
        "dryRun reports what would be uploaded, sending nothing. Next: plan_addressables_publish.",
      inputSchema: z.object({
        gameId: gameIdSchema,
        serverDataPath: z.string().describe("The Addressables build output folder for WebGL, such as ServerData/WebGL"),
        catalog: z
          .string()
          .optional()
          .describe("Which catalog to upload, such as catalog_1.0.3.bin — needed only when the folder holds several"),
        dryRun: z.boolean().optional().describe("Report what would be uploaded without uploading"),
      }),
      outputSchema: z.object({
        gameId: z.string(),
        dryRun: z.boolean(),
        catalog: z.string(),
        fileCount: z.number(),
        totalBytes: z.number(),
        uploaded: z.number(),
        uploadedBytes: z.number(),
        reused: z.number(),
        ignored: z.array(z.string()),
        readyToPublish: z.boolean(),
        staging: z.object({ fileCount: z.number(), totalBytes: z.number(), maxFiles: z.number(), maxBytes: z.number() }),
        nextStep: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ gameId, serverDataPath, catalog, dryRun }, ctx) => {
      try {
        const result = await uploadAddressables(
          { gameId, serverDataPath: isAbsolute(serverDataPath) ? serverDataPath : resolve(cwd(), serverDataPath), catalog, dryRun },
          { api, progress: progressFor(ctx), signal: ctx.mcpReq.signal },
        );
        const lines = [
          result.dryRun
            ? `Would stage ${result.catalog} with ${result.fileCount} files (${MB(result.totalBytes)}); at least ${result.reused} bundle(s) are already live and would be skipped.`
            : `Staged ${result.catalog}: ${result.fileCount} files (${MB(result.totalBytes)}) — ${result.uploaded} uploaded (${MB(result.uploadedBytes)}), ${result.reused} already on SusaPlay.`,
          ...(result.ignored.length ? [`Ignored ${result.ignored.length} file(s) from other content builds in the folder.`] : []),
          `Staging: ${result.staging.fileCount} of ${result.staging.maxFiles} files, ${MB(result.staging.totalBytes)} of 5 GB.`,
          result.nextStep,
        ];
        return ok(lines.join("\n"), { ...result });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "plan_addressables_publish",
    {
      title: "Plan an Addressables publish",
      description:
        "Shows exactly what publishing the game's staged Addressables would do, changing nothing: the release it " +
        "would create, files added, removed and unchanged, the catalog change, the compatibility check against the " +
        "live build, and which old release would no longer be kept. Show the plan to the developer. Its " +
        "expectedLiveReleaseId and expectedStagingHash are what publish_addressables needs.",
      inputSchema: z.object({ gameId: gameIdSchema }),
      outputSchema: z.object({
        gameId: z.string(),
        releaseNumber: z.number().nullable(),
        catalogVersion: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
        filesAdded: z.array(z.string()),
        filesRemoved: z.array(z.string()),
        filesUnchangedCount: z.number(),
        releasesDropped: z.array(z.number()),
        compatibility: compatibilitySchema,
        expectedLiveReleaseId: z.string().nullable(),
        expectedStagingHash: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ gameId }) => {
      try {
        const plan = await api.post<Record<string, unknown>>(`/catalog/game/${encodeURIComponent(gameId)}/addressables/publish`, { dryRun: true });
        const catalogVersion = (plan.catalogVersion ?? {}) as { from?: unknown; to?: unknown };
        const result = {
          gameId,
          releaseNumber: num(plan.releaseNumber),
          catalogVersion: { from: str(catalogVersion.from), to: str(catalogVersion.to) },
          filesAdded: strings(plan.filesAdded),
          filesRemoved: strings(plan.filesRemoved),
          filesUnchangedCount: strings(plan.filesUnchanged).length,
          releasesDropped: numbers(plan.releasesDropped),
          compatibility: readCompatibility(plan.compatibility as ApiCompatibility),
          expectedLiveReleaseId: str(plan.expectedLiveReleaseId),
          expectedStagingHash: str(plan.expectedStagingHash) ?? "",
        };
        const lines = [
          `Publishing would create release ${result.releaseNumber ?? "?"}: catalog ${result.catalogVersion.from ?? "none"} → ${result.catalogVersion.to ?? "none"}.`,
          listSummary("Files added", result.filesAdded),
          listSummary("Files removed from players", result.filesRemoved),
          `Files unchanged: ${result.filesUnchangedCount}`,
          ...(result.releasesDropped.length ? [`Releases no longer kept afterwards: ${result.releasesDropped.join(", ")}.`] : []),
          ...describeChecks(result.compatibility),
          result.compatibility.compatible
            ? "Show this plan to the developer. If they confirm, call publish_addressables with expectedLiveReleaseId and expectedStagingHash from this plan."
            : "Publishing would be refused. Do not try to publish; fix the content as the failed checks say, then upload and plan again.",
        ];
        return ok(lines.join("\n"), result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "publish_addressables",
    {
      title: "Publish Addressables to players",
      description:
        "Makes the game's staged Addressables live for every player, immediately — there is no review. Run " +
        "plan_addressables_publish first, show the developer the plan, and publish only after they confirm. " +
        "Refused when the live release or staging changed since the plan, when the content would break the live " +
        "build, or while another publish or rollback runs. A mistake can be undone with rollback_addressables.",
      inputSchema: z.object({
        gameId: gameIdSchema,
        expectedLiveReleaseId: expectedLiveSchema,
        expectedStagingHash: z.string().min(1).max(128).describe("expectedStagingHash from plan_addressables_publish"),
      }),
      outputSchema: z.object({
        gameId: z.string(),
        releaseNumber: z.number().nullable(),
        catalogVersion: z.string().nullable(),
        fileCount: z.number(),
        changedFiles: z.number(),
        removedFiles: z.number(),
        deletedReleases: z.array(z.number()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ gameId, expectedLiveReleaseId, expectedStagingHash }) => {
      try {
        let data: Record<string, unknown>;
        try {
          data = await api.post(`/catalog/game/${encodeURIComponent(gameId)}/addressables/publish`, {
            expectedLiveReleaseId,
            expectedStagingHash,
          });
        } catch (error) {
          refusal(error);
        }
        const result = {
          gameId,
          releaseNumber: num(data.releaseNumber),
          catalogVersion: str(data.catalogVersion),
          fileCount: strings(data.publishedFiles).length,
          changedFiles: strings(data.changedFiles).length,
          removedFiles: strings(data.removedFiles).length,
          deletedReleases: numbers(data.deletedReleases),
        };
        const lines = [
          `Release ${result.releaseNumber ?? "?"} is live: catalog ${result.catalogVersion ?? "?"}, ${result.fileCount} files (${result.changedFiles} changed, ${result.removedFiles} removed).`,
          "Players get it on their next catalog check.",
          ...(result.deletedReleases.length ? [`Releases no longer kept: ${result.deletedReleases.join(", ")}.`] : []),
          "To undo, rollback_addressables can restore an earlier release.",
        ];
        return ok(lines.join("\n"), result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "rollback_addressables",
    {
      title: "Roll Addressables back to an earlier release",
      description:
        "Makes one of the game's kept Addressables releases live again, for every player, immediately. Use " +
        "get_addressables to list the releases and the live one, tell the developer which release will be restored, " +
        "and roll back only after they confirm. The release is checked against the current live build first and " +
        "refused if it would break it. Creates no release and leaves staging untouched; undo it with another rollback.",
      inputSchema: z.object({
        gameId: gameIdSchema,
        releaseId: releaseIdSchema,
        expectedLiveReleaseId: expectedLiveSchema.describe("liveReleaseId from get_addressables, exactly as returned"),
      }),
      outputSchema: z.object({
        gameId: z.string(),
        releaseNumber: z.number().nullable(),
        fromReleaseNumber: z.number().nullable(),
        catalogVersion: z.string().nullable(),
        fileCount: z.number().nullable(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ gameId, releaseId, expectedLiveReleaseId }) => {
      try {
        let data: Record<string, unknown>;
        try {
          data = await api.post(`/catalog/game/${encodeURIComponent(gameId)}/addressables/rollback`, { releaseId, expectedLiveReleaseId });
        } catch (error) {
          refusal(error);
        }
        const result = {
          gameId,
          releaseNumber: num(data.releaseNumber),
          fromReleaseNumber: num(data.fromReleaseNumber),
          catalogVersion: str(data.catalogVersion),
          fileCount: num(data.fileCount),
        };
        return ok(
          `Release ${result.releaseNumber ?? releaseId} is live again (catalog ${result.catalogVersion ?? "?"}), replacing release ` +
            `${result.fromReleaseNumber ?? "?"}. Players get it on their next catalog check. Staging is unchanged.`,
          result,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );
}

