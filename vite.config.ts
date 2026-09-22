import path from "path";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { promises as fs } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { defineConfig, loadEnv, type ViteDevServer, type PreviewServer } from "vite";
import react from "@vitejs/plugin-react";
import { createGeminiMiddleware } from "./server/geminiMiddleware";
import { createVoicevoxMiddleware } from "./server/voicevoxMiddleware";
import { createDemoRecordEventHub, type DemoRecordEventHub } from "./server/demoRecordEvents";
import { demoRecordErrorStatus, DemoRecordRequestError, getRecordDirectory, getRecordFilePath, isAnimationClockAudio, isAnimationClockFile, validateDemoRecordName } from "./server/demoRecordFiles";

const MAX_RECORD_REQUEST_BYTES = 100 * 1024 * 1024;
const DEFAULT_DEMO_RECORDS_DIR = path.resolve(process.cwd(), "demo-records");
const USAGE_STATS_FILE_NAME = "usage-stats.json";
const GENERATION_TIMINGS_FILE_NAME = "generation-timings.json";
const GENERATION_TIMINGS_SCHEMA_VERSION = 1;
const MAX_GENERATION_TIMING_ENTRIES = 300;
const TOKYO_TIME_ZONE = "Asia/Tokyo";

const getBuildId = () => {
  const configured = process.env.VITE_APP_BUILD_ID?.trim();
  if (configured) return configured;

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
};

const sendJson = (response: ServerResponse, statusCode: number, payload: unknown) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

const readRequestBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_RECORD_REQUEST_BYTES) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const sanitizePathPart = (value: unknown) => {
  const text = typeof value === "string" ? value : "";
  const sanitized = text
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

  return sanitized || "untitled";
};

const parseDataUri = (value: unknown) => {
  if (typeof value !== "string") {
    throw new Error("Data URI is missing");
  }

  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);

  if (!match) {
    throw new Error("Invalid data URI");
  }

  const [, mimeType = "application/octet-stream", base64Marker, data] = match;
  const buffer = base64Marker
    ? Buffer.from(data, "base64")
    : Buffer.from(decodeURIComponent(data), "utf8");

  return { buffer, mimeType };
};

const getAudioFileName = (mimeType: string) => {
  if (mimeType.includes("mpeg")) {
    return "voice.mp3";
  }

  if (mimeType.includes("ogg")) {
    return "voice.ogg";
  }

  return "voice.wav";
};

type DemoRecordStatus = "success" | "error";

type StoredDemoRecordMetadata = {
  recordId?: string;
  savedAt?: string;
  status?: DemoRecordStatus;
  playbackKind?: "voice" | "animation-only";
  favorite?: boolean;
  files?: {
    image?: string;
    audio?: string;
  };
  mimeTypes?: {
    image?: string;
    audio?: string | null;
  };
  lyrics?: {
    title?: string;
    lines?: string[];
    singingKanaLines?: string[];
    identifiedObject?: string;
    lineStrokeMappings?: unknown[];
    modelName?: string;
  } | null;
  drawing?: {
    strokes?: unknown[];
    strokeGroups?: unknown[];
    canvasSize?: {
      width?: number;
      height?: number;
    };
    lineWidth?: number;
  };
  participantAge?: number | null;
  participant?: {
    age?: number | null;
  };
  singingScore?: unknown;
};

type StoredUsageStatsDay = {
  generationCount: number;
  recordedCount: number;
  unrecordedCount: number;
};

type StoredUsageStats = {
  totalGenerations: number;
  recordedGenerations: number;
  unrecordedGenerations: number;
  days: Record<string, StoredUsageStatsDay>;
};

type UsageStatsResponse = Omit<StoredUsageStats, "days"> & {
  days: Array<StoredUsageStatsDay & { date: string }>;
};

let usageStatsWriteQueue: Promise<void> = Promise.resolve();
let generationTimingsWriteQueue: Promise<void> = Promise.resolve();

const GENERATION_TIMING_PHASES = ["gemini", "accent", "score", "voicevoxQuery", "voicevoxSynthesis", "finalize"] as const;
type GenerationTimingPhase = (typeof GENERATION_TIMING_PHASES)[number];
type StoredGenerationTimingEntry = {
  recordedAt: string;
  success: boolean;
  failedStage: GenerationTimingPhase | null;
  modelName: string | null;
  voicevoxProfile: string;
  strokeCount: number;
  strokeGroupCount: number;
  pointCount: number;
  lyricLineCount: number;
  noteCount: number;
  totalFrames: number;
  durationsMs: Partial<Record<GenerationTimingPhase, number>>;
  totalMs: number;
};

type StoredGenerationTimings = {
  schemaVersion: number;
  entries: StoredGenerationTimingEntry[];
};

const isSafeNonNegativeNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400_000;
const isSafeMetric = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;

const normalizeGenerationTimingEntry = (value: unknown, voicevoxProfile: string, recordedAt = new Date().toISOString()): StoredGenerationTimingEntry | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.success !== "boolean" || !isSafeNonNegativeNumber(candidate.totalMs)) return null;

  const failedStage = candidate.failedStage;
  if (failedStage !== null && !GENERATION_TIMING_PHASES.includes(failedStage as GenerationTimingPhase)) return null;
  const durationsSource = candidate.durationsMs;
  const durationsMs: Partial<Record<GenerationTimingPhase, number>> = {};
  if (durationsSource && typeof durationsSource === "object") {
    for (const phase of GENERATION_TIMING_PHASES) {
      const duration = (durationsSource as Record<string, unknown>)[phase];
      if (isSafeNonNegativeNumber(duration)) durationsMs[phase] = Math.round(Number(duration));
    }
  }

  const metric = (name: string) => isSafeMetric(candidate[name]) ? Number(candidate[name]) : 0;
  return {
    recordedAt,
    success: candidate.success,
    failedStage: failedStage as GenerationTimingPhase | null,
    modelName: typeof candidate.modelName === "string" ? candidate.modelName.slice(0, 160) : null,
    voicevoxProfile,
    strokeCount: metric("strokeCount"),
    strokeGroupCount: metric("strokeGroupCount"),
    pointCount: metric("pointCount"),
    lyricLineCount: metric("lyricLineCount"),
    noteCount: metric("noteCount"),
    totalFrames: metric("totalFrames"),
    durationsMs,
    totalMs: Math.round(Number(candidate.totalMs)),
  };
};

const parseGenerationTimings = (value: unknown): StoredGenerationTimings => {
  if (!value || typeof value !== "object") throw new Error("Generation timings file is invalid");
  const candidate = value as Partial<StoredGenerationTimings>;
  if (candidate.schemaVersion !== GENERATION_TIMINGS_SCHEMA_VERSION || !Array.isArray(candidate.entries)) {
    throw new Error("Generation timings file is invalid");
  }
  // The on-disk file only ever contains normalized entries. Filter rather than fail so one old row cannot block estimates.
  return {
    schemaVersion: GENERATION_TIMINGS_SCHEMA_VERSION,
    entries: candidate.entries
      .map((entry) => {
        const stored = entry as Partial<StoredGenerationTimingEntry>;
        const recordedAt = typeof stored.recordedAt === "string" && Number.isFinite(Date.parse(stored.recordedAt)) ? stored.recordedAt : new Date().toISOString();
        return normalizeGenerationTimingEntry(entry, typeof stored.voicevoxProfile === "string" ? stored.voicevoxProfile : "local-pc", recordedAt);
      })
      .filter((entry): entry is StoredGenerationTimingEntry => entry !== null)
      .slice(-MAX_GENERATION_TIMING_ENTRIES),
  };
};

const readGenerationTimings = async (recordsRoot: string): Promise<StoredGenerationTimings> => {
  const timingsPath = path.join(recordsRoot, GENERATION_TIMINGS_FILE_NAME);
  try {
    return parseGenerationTimings(JSON.parse(await fs.readFile(timingsPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: GENERATION_TIMINGS_SCHEMA_VERSION, entries: [] };
    }
    throw error;
  }
};

const writeGenerationTimings = async (recordsRoot: string, timings: StoredGenerationTimings) => {
  await fs.mkdir(recordsRoot, { recursive: true });
  const timingsPath = path.join(recordsRoot, GENERATION_TIMINGS_FILE_NAME);
  const temporaryPath = path.join(recordsRoot, `${GENERATION_TIMINGS_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporaryPath, `${JSON.stringify({ ...timings, entries: timings.entries.slice(-MAX_GENERATION_TIMING_ENTRIES) }, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, timingsPath);
};

const runGenerationTimingsUpdate = <T>(operation: () => Promise<T>) => {
  const result = generationTimingsWriteQueue.then(operation, operation);
  generationTimingsWriteQueue = result.then(() => undefined, () => undefined);
  return result;
};

const percentile75 = (values: number[]) => {
  const sorted = values.filter((value) => value > 0 && Number.isFinite(value)).sort((first, second) => first - second);
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.75) - 1)];
};

const MAX_ESTIMATE_TOTAL_MS = 60_000;

const getGenerationTimingEstimate = (entries: StoredGenerationTimingEntry[], voicevoxProfile: string) => {
  const successes = entries
    .filter((entry) => entry.success && entry.totalMs > 0 && entry.totalMs < MAX_ESTIMATE_TOTAL_MS)
    .slice(-MAX_GENERATION_TIMING_ENTRIES);
  const profileEntries = successes.filter((entry) => entry.voicevoxProfile === voicevoxProfile);
  const modelCounts = new Map<string, number>();
  for (const entry of profileEntries) {
    if (entry.modelName) modelCounts.set(entry.modelName, (modelCounts.get(entry.modelName) ?? 0) + 1);
  }
  const preferredModel = [...modelCounts.entries()]
    .filter(([, count]) => count >= 5)
    .sort(([, firstCount], [, secondCount]) => secondCount - firstCount)[0]?.[0];
  // Never mix timing profiles. A model-specific subset is used only when it has enough samples itself.
  const selected = preferredModel ? profileEntries.filter((entry) => entry.modelName === preferredModel) : profileEntries;
  const recentSelected = selected.slice(-10);
  const phaseDurationsMs = Object.fromEntries(
    GENERATION_TIMING_PHASES.map((phase) => [phase, percentile75(recentSelected.map((entry) => entry.durationsMs[phase] ?? 0)) ?? 0]),
  ) as Record<GenerationTimingPhase, number>;
  return {
    determinate: recentSelected.length >= 3,
    sampleCount: recentSelected.length,
    estimatedTotalMs: percentile75(recentSelected.map((entry) => entry.totalMs)) ?? 0,
    phaseDurationsMs,
  };
};

const readDemoRecordMetadata = async (recordDirectory: string) =>
  JSON.parse(await fs.readFile(await getRecordFilePath(recordDirectory, "metadata.json"), "utf8")) as StoredDemoRecordMetadata;

const getTokyoDate = (value: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TOKYO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;

  return `${part("year")}-${part("month")}-${part("day")}`;
};

const emptyUsageStats = (): StoredUsageStats => ({
  totalGenerations: 0,
  recordedGenerations: 0,
  unrecordedGenerations: 0,
  days: {},
});

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const parseUsageStats = (value: unknown): StoredUsageStats => {
  if (!value || typeof value !== "object") {
    throw new Error("Usage stats file is invalid");
  }

  const candidate = value as Partial<StoredUsageStats>;
  if (!isCount(candidate.totalGenerations) || !isCount(candidate.recordedGenerations) || !isCount(candidate.unrecordedGenerations) || !candidate.days || typeof candidate.days !== "object") {
    throw new Error("Usage stats file is invalid");
  }

  const days: Record<string, StoredUsageStatsDay> = {};
  for (const [date, counts] of Object.entries(candidate.days)) {
    if (!counts || typeof counts !== "object") {
      throw new Error("Usage stats file is invalid");
    }

    const day = counts as Partial<StoredUsageStatsDay>;
    if (!isCount(day.generationCount) || !isCount(day.recordedCount) || !isCount(day.unrecordedCount)) {
      throw new Error("Usage stats file is invalid");
    }

    days[date] = {
      generationCount: day.generationCount,
      recordedCount: day.recordedCount,
      unrecordedCount: day.unrecordedCount,
    };
  }

  return {
    totalGenerations: candidate.totalGenerations,
    recordedGenerations: candidate.recordedGenerations,
    unrecordedGenerations: candidate.unrecordedGenerations,
    days,
  };
};

const initializeUsageStats = async (recordsRoot: string) => {
  const stats = emptyUsageStats();
  await fs.mkdir(recordsRoot, { recursive: true });
  const entries = await fs.readdir(recordsRoot, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const metadata = await readDemoRecordMetadata(await getRecordDirectory(recordsRoot, entry.name));
          const savedAt = typeof metadata.savedAt === "string" ? new Date(metadata.savedAt) : null;
          if (!savedAt || Number.isNaN(savedAt.getTime())) {
            return;
          }

          const date = getTokyoDate(savedAt);
          const day = stats.days[date] ?? { generationCount: 0, recordedCount: 0, unrecordedCount: 0 };
          day.generationCount += 1;
          day.recordedCount += 1;
          stats.days[date] = day;
          stats.totalGenerations += 1;
          stats.recordedGenerations += 1;
        } catch {
          // A broken or partial legacy record must not block stats initialization.
        }
      }),
  );

  return stats;
};

const writeUsageStats = async (recordsRoot: string, stats: StoredUsageStats) => {
  const statsPath = path.join(recordsRoot, USAGE_STATS_FILE_NAME);
  const temporaryPath = path.join(recordsRoot, `${USAGE_STATS_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, statsPath);
};

const readOrInitializeUsageStats = async (recordsRoot: string) => {
  const statsPath = path.join(recordsRoot, USAGE_STATS_FILE_NAME);
  try {
    return parseUsageStats(JSON.parse(await fs.readFile(statsPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    const stats = await initializeUsageStats(recordsRoot);
    await writeUsageStats(recordsRoot, stats);
    return stats;
  }
};

const toUsageStatsResponse = (stats: StoredUsageStats): UsageStatsResponse => ({
  totalGenerations: stats.totalGenerations,
  recordedGenerations: stats.recordedGenerations,
  unrecordedGenerations: stats.unrecordedGenerations,
  days: Object.entries(stats.days)
    .map(([date, counts]) => ({ date, ...counts }))
    .sort((first, second) => second.date.localeCompare(first.date)),
});

const runUsageStatsUpdate = <T>(operation: () => Promise<T>) => {
  const result = usageStatsWriteQueue.then(operation, operation);
  usageStatsWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const getDemoRecordPlaybackKind = async (directory: string, metadata: StoredDemoRecordMetadata): Promise<"voice" | "animation-only"> => {
  if (metadata.playbackKind === "animation-only" || !metadata.files?.audio) return "animation-only";
  try {
    const audioPath = await getRecordFilePath(directory, metadata.files.audio);
    if (!metadata.playbackKind && await isAnimationClockFile(audioPath)) return "animation-only";
    return "voice";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "animation-only";
    throw error;
  }
};

const buildRecordUrls = (recordId: string, playbackKind: "voice" | "animation-only") => ({
  imageUrl: `/api/demo-records/${encodeURIComponent(recordId)}/image`,
  audioUrl: playbackKind === "voice" ? `/api/demo-records/${encodeURIComponent(recordId)}/audio` : null,
});

const buildDemoRecordSummary = async (recordId: string, directory: string, metadata: StoredDemoRecordMetadata) => {
  const playbackKind = await getDemoRecordPlaybackKind(directory, metadata);
  const { imageUrl, audioUrl } = buildRecordUrls(recordId, playbackKind);

  return {
    recordId,
    savedAt: metadata.savedAt ?? "",
    title: metadata.lyrics?.title?.trim() || "無題のお絵描き歌",
    identifiedObject: metadata.lyrics?.identifiedObject?.trim() || "絵",
    imageUrl,
    audioUrl,
    hasAudio: playbackKind === "voice",
    playbackKind,
    participantAge: metadata.participantAge ?? metadata.participant?.age ?? null,
    isFavorite: metadata.favorite ?? false,
  };
};

const updateDemoRecordMetadata = async (
  recordsRoot: string,
  recordId: string,
  updater: (metadata: StoredDemoRecordMetadata) => StoredDemoRecordMetadata,
) => {
  const recordDirectory = await getRecordDirectory(recordsRoot, recordId);
  const currentMetadata = await readDemoRecordMetadata(recordDirectory);
  const nextMetadata = updater(currentMetadata);

  await fs.writeFile(path.join(recordDirectory, "metadata.json"), `${JSON.stringify(nextMetadata, null, 2)}\n`, "utf8");

  return nextMetadata;
};

const listDemoRecords = async (recordsRoot: string) => {
  await fs.mkdir(recordsRoot, { recursive: true });

  const entries = await fs.readdir(recordsRoot, { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const recordDirectory = await getRecordDirectory(recordsRoot, entry.name);
          const metadata = await readDemoRecordMetadata(recordDirectory);

          if (metadata.status !== "success" || !metadata.files?.image || !metadata.lyrics) {
            return null;
          }

          return await buildDemoRecordSummary(entry.name, recordDirectory, metadata);
        } catch {
          return null;
        }
      }),
  );

  return records
    .filter((record): record is NonNullable<(typeof records)[number]> => record !== null)
    .sort((first, second) => second.savedAt.localeCompare(first.savedAt));
};

const sendDemoRecordFile = async (
  response: ServerResponse,
  recordsRoot: string,
  recordId: string,
  fileType: "image" | "audio",
) => {
  const recordDirectory = await getRecordDirectory(recordsRoot, recordId);
  const metadata = await readDemoRecordMetadata(recordDirectory);
  const fileName = metadata.files?.[fileType];

  if (!fileName || (fileType === "audio" && await getDemoRecordPlaybackKind(recordDirectory, metadata) !== "voice")) {
    sendJson(response, 404, { error: "Demo record file not found" });
    return;
  }

  const filePath = await getRecordFilePath(recordDirectory, fileName);

  const file = await fs.readFile(filePath);
  response.statusCode = 200;
  response.setHeader("Content-Type", metadata.mimeTypes?.[fileType] ?? "application/octet-stream");
  response.setHeader("Cache-Control", "no-store");
  response.end(file);
};

export const createDemoRecordMiddleware =
  (recordsRoot: string, voicevoxTimingProfile: string, events: DemoRecordEventHub) => async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const pathname = request.url?.split(/[?#]/, 1)[0] ?? "";
    if (pathname !== "/api/demo-records" && !pathname.startsWith("/api/demo-records/")) {
      next();
      return;
    }

    const origin = request.headers.origin;
    const site = request.headers["sec-fetch-site"];
    const protocol = "encrypted" in request.socket && request.socket.encrypted ? "https" : "http";
    if ((origin && origin !== `${protocol}://${request.headers.host}`) || (site && site !== "same-origin" && site !== "none")) {
      sendJson(response, 403, { error: "同じサイトからのみ利用できます。" });
      return;
    }

    // Parse the raw path before URL normalization can discard dot segments.
    const pathParts = pathname.replace(/\/$/, "").split("/").slice(1);
    let recordId: string | null = null;
    let fileType: string | null = null;
    try {
      if (pathParts.length > 4) throw new DemoRecordRequestError("Invalid demo record path");
      if (pathParts.length >= 3) {
        recordId = decodeURIComponent(pathParts[2]);
        validateDemoRecordName(recordId);
      }
      if (pathParts.length >= 4) {
        fileType = decodeURIComponent(pathParts[3]);
        validateDemoRecordName(fileType);
      }
    } catch (error) {
      sendJson(response, demoRecordErrorStatus(error), { error: "Invalid demo record path" });
      return;
    }

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if ((request.method === "POST" || request.method === "PATCH") && !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
      sendJson(response, 415, { error: "Content-Type must be application/json" });
      return;
    }

    // Named routes must precede the generic record GET/DELETE/PATCH handlers.
    if (pathParts.length === 3 && recordId === "events") {
      if (request.method === "GET") events.connect(request, response);
      else sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    const isTimingEstimatesRoute = pathParts.length === 3 && recordId === "timing-estimates";
    if (isTimingEstimatesRoute && request.method === "GET") {
      try {
        const timings = await runGenerationTimingsUpdate(() => readGenerationTimings(recordsRoot));
        sendJson(response, 200, getGenerationTimingEstimate(timings.entries, voicevoxTimingProfile));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to read generation timings";
        sendJson(response, 500, { error: message });
      }
      return;
    }

    const isTimingsRoute = pathParts.length === 3 && recordId === "timings";
    if (isTimingsRoute && request.method === "POST") {
      try {
        const entry = normalizeGenerationTimingEntry(JSON.parse(await readRequestBody(request)), voicevoxTimingProfile);
        if (!entry) {
          sendJson(response, 400, { error: "Invalid generation timing payload" });
          return;
        }
        await runGenerationTimingsUpdate(async () => {
          const current = await readGenerationTimings(recordsRoot);
          current.entries.push(entry);
          current.entries = current.entries.slice(-MAX_GENERATION_TIMING_ENTRIES);
          await writeGenerationTimings(recordsRoot, current);
        });
        sendJson(response, 201, { saved: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to save generation timing";
        sendJson(response, 500, { error: message });
      }
      return;
    }

    const isStatsRoute = pathParts.length === 3 && recordId === "stats";

    if (isStatsRoute && request.method === "GET") {
      try {
        const stats = await runUsageStatsUpdate(() => readOrInitializeUsageStats(recordsRoot));
        sendJson(response, 200, toUsageStatsResponse(stats));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to read usage stats";
        sendJson(response, 500, { error: message });
      }
      return;
    }

    if (isStatsRoute && request.method === "POST") {
      try {
        const payload = JSON.parse(await readRequestBody(request)) as { recorded?: unknown };
        if (typeof payload.recorded !== "boolean") {
          sendJson(response, 400, { error: "recorded must be a boolean" });
          return;
        }
        const stats = await runUsageStatsUpdate(async () => {
          const current = await readOrInitializeUsageStats(recordsRoot);
          const date = getTokyoDate(new Date());
          const day = current.days[date] ?? { generationCount: 0, recordedCount: 0, unrecordedCount: 0 };
          day.generationCount += 1;
          if (payload.recorded) {
            current.recordedGenerations += 1;
            day.recordedCount += 1;
          } else {
            current.unrecordedGenerations += 1;
            day.unrecordedCount += 1;
          }
          current.totalGenerations += 1;
          current.days[date] = day;
          await writeUsageStats(recordsRoot, current);
          return current;
        });

        sendJson(response, 200, toUsageStatsResponse(stats));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update usage stats";
        sendJson(response, 500, { error: message });
      }
      return;
    }

    if (request.method === "GET") {
      try {
        if (pathParts.length === 2) {
          sendJson(response, 200, { records: await listDemoRecords(recordsRoot) });
          return;
        }

        if (recordId && pathParts.length === 3) {
          const recordDirectory = await getRecordDirectory(recordsRoot, recordId);
          const metadata = await readDemoRecordMetadata(recordDirectory);

          if (metadata.status !== "success" || !metadata.lyrics) {
            sendJson(response, 404, { error: "Demo record not found" });
            return;
          }

          sendJson(response, 200, {
            ...await buildDemoRecordSummary(recordId, recordDirectory, metadata),
            lyrics: metadata.lyrics,
            drawingData: {
              strokes: metadata.drawing?.strokes ?? [],
              strokeGroups: metadata.drawing?.strokeGroups,
              canvasSize: metadata.drawing?.canvasSize,
              lineWidth: metadata.drawing?.lineWidth,
              imageUri: `/api/demo-records/${encodeURIComponent(recordId)}/image`,
            },
            singingScore: metadata.singingScore ?? null,
          });
          return;
        }

        if (recordId && pathParts.length === 4 && (fileType === "image" || fileType === "audio")) {
          await sendDemoRecordFile(response, recordsRoot, recordId, fileType);
          return;
        }

        sendJson(response, 404, { error: "Demo record not found" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to read demo records";
        sendJson(response, demoRecordErrorStatus(error), { error: message });
      }
      return;
    }

    if (request.method === "DELETE" && recordId && pathParts.length === 3) {
      try {
        const recordDirectory = await getRecordDirectory(recordsRoot, recordId, true);
        await fs.rm(recordDirectory, { recursive: true, force: true });
        events.publish({ kind: "deleted", recordId });
        sendJson(response, 200, { recordId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete demo record";
        sendJson(response, demoRecordErrorStatus(error), { error: message });
      }
      return;
    }

    if (request.method === "PATCH" && recordId && pathParts.length === 3) {
      try {
        const payload = JSON.parse(await readRequestBody(request)) as { favorite?: unknown };
        if (typeof payload.favorite !== "boolean") {
          sendJson(response, 400, { error: "favorite must be a boolean" });
          return;
        }

        const favorite = payload.favorite;

        const nextMetadata = await updateDemoRecordMetadata(recordsRoot, recordId, (metadata) => ({
          ...metadata,
          favorite,
        }));

        events.publish({ kind: "updated", recordId });

        sendJson(response, 200, {
          recordId,
          isFavorite: nextMetadata.favorite ?? false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update demo record";
        sendJson(response, demoRecordErrorStatus(error), { error: message });
      }
      return;
    }

    if (request.method !== "POST" || pathParts.length !== 2) {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    try {
      const payload = JSON.parse(await readRequestBody(request)) as {
        imageDataUri?: unknown;
        audioDataUri?: unknown;
        metadata?: Record<string, unknown>;
      };
      const metadata = payload.metadata ?? {};
      const image = parseDataUri(payload.imageDataUri);
      if (metadata.playbackKind !== undefined && metadata.playbackKind !== "voice" && metadata.playbackKind !== "animation-only") {
        throw new DemoRecordRequestError("Invalid demo record playback kind");
      }
      const submittedAudio = metadata.playbackKind !== "animation-only" && payload.audioDataUri ? parseDataUri(payload.audioDataUri) : null;
      const audio = submittedAudio && !isAnimationClockAudio(submittedAudio.buffer) ? submittedAudio : null;
      const savedAt = new Date().toISOString();
      const timestamp = savedAt.replace(/[:.]/g, "-");
      const title = (metadata.lyrics as { title?: unknown } | undefined)?.title;
      const status = metadata.status === "error" ? "error" : "success";
      const recordId = `${timestamp}_${status}_${sanitizePathPart(title)}_${randomUUID().slice(0, 8)}`;
      const recordDirectory = path.join(recordsRoot, recordId);
      const files: Record<string, string> = {
        image: "input.png",
      };

      await fs.mkdir(recordsRoot, { recursive: true });
      // Do not follow a pre-existing directory or link on an ID collision.
      await fs.mkdir(recordDirectory);
      await fs.writeFile(path.join(recordDirectory, files.image), image.buffer);

      if (audio) {
        files.audio = getAudioFileName(audio.mimeType);
        await fs.writeFile(path.join(recordDirectory, files.audio), audio.buffer);
      }

      await fs.writeFile(
        path.join(recordDirectory, "metadata.json"),
        `${JSON.stringify(
          {
            ...metadata,
            schemaVersion: 1,
            recordId,
            savedAt,
            status,
            playbackKind: audio ? "voice" : "animation-only",
            files,
            mimeTypes: {
              image: image.mimeType,
              audio: audio?.mimeType ?? null,
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      events.publish({ kind: "created", recordId });
      sendJson(response, 201, {
        recordId,
        directory: recordDirectory,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save demo record";
      sendJson(response, demoRecordErrorStatus(error), { error: message });
    }
  };

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const buildId = getBuildId();
  const isDev = mode === "development";
  const demoRecordsDir = env.DEMO_RECORDS_DIR ? path.resolve(env.DEMO_RECORDS_DIR) : DEFAULT_DEMO_RECORDS_DIR;
  const disposeEventHubs = new Set<() => void>();
  const attachDemoRecords = (server: Pick<ViteDevServer | PreviewServer, "httpServer" | "middlewares">) => {
    const events = createDemoRecordEventHub();
    const dispose = () => {
      events.close();
      disposeEventHubs.delete(dispose);
      server.httpServer?.off("close", dispose);
    };
    disposeEventHubs.add(dispose);
    server.httpServer?.once("close", dispose);
    server.middlewares.use(createDemoRecordMiddleware(demoRecordsDir, env.VOICEVOX_TIMING_PROFILE?.trim() || "local-pc", events));
  };

  return {
    define: {
      __APP_BUILD_ID__: JSON.stringify(buildId),
    },
    server: {
      port: 3000,
      host: "0.0.0.0",
      proxy: isDev
        ? {
          "/voicevox": {
            target: "http://127.0.0.1:50021",
            changeOrigin: true,
            rewrite: (requestPath) => requestPath.replace(/^\/voicevox/, ""),
            configure: (proxy) => {
              proxy.on("proxyReq", (proxyRequest) => {
                proxyRequest.setHeader("Origin", "http://127.0.0.1:50021");
              });
            },
          },
        }
        : undefined,
      cors: isDev,
    },
    plugins: [
      react(),
      {
        name: "local-api",
        configureServer(server) {
          server.middlewares.use(createVoicevoxMiddleware(env));
          server.middlewares.use(createGeminiMiddleware(env));
          attachDemoRecords(server);
        },
        configurePreviewServer(server) {
          server.middlewares.use(createGeminiMiddleware(env));
          attachDemoRecords(server);
        },
        closeBundle() {
          // Also covers middleware-mode dev servers without their own HTTP server.
          for (const dispose of disposeEventHubs) dispose();
        },
      },
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
      },
    },
  };
});
