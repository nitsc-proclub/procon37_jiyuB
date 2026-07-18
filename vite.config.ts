import path from "path";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { createGeminiMiddleware } from "./server/geminiMiddleware";

const MAX_RECORD_REQUEST_BYTES = 100 * 1024 * 1024;
const DEFAULT_DEMO_RECORDS_DIR = path.resolve(process.cwd(), "demo-records");
const USAGE_STATS_FILE_NAME = "usage-stats.json";
const TOKYO_TIME_ZONE = "Asia/Tokyo";

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

const isPathInside = (parentDirectory: string, targetPath: string) => {
  const relativePath = path.relative(parentDirectory, targetPath);
  return relativePath === "" || (!!relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
};

const getRecordDirectory = (recordsRoot: string, recordId: string) => {
  const recordDirectory = path.resolve(recordsRoot, recordId);

  if (!isPathInside(recordsRoot, recordDirectory)) {
    throw new Error("Invalid demo record id");
  }

  return recordDirectory;
};

const readDemoRecordMetadata = async (recordDirectory: string) =>
  JSON.parse(await fs.readFile(path.join(recordDirectory, "metadata.json"), "utf8")) as StoredDemoRecordMetadata;

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
          const metadata = await readDemoRecordMetadata(getRecordDirectory(recordsRoot, entry.name));
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

const buildRecordUrls = (recordId: string, metadata: StoredDemoRecordMetadata) => ({
  imageUrl: `/api/demo-records/${encodeURIComponent(recordId)}/image`,
  audioUrl: metadata.files?.audio ? `/api/demo-records/${encodeURIComponent(recordId)}/audio` : null,
});

const buildDemoRecordSummary = (recordId: string, metadata: StoredDemoRecordMetadata) => {
  const { imageUrl, audioUrl } = buildRecordUrls(recordId, metadata);

  return {
    recordId,
    savedAt: metadata.savedAt ?? "",
    title: metadata.lyrics?.title?.trim() || "無題のお絵描き歌",
    identifiedObject: metadata.lyrics?.identifiedObject?.trim() || "絵",
    imageUrl,
    audioUrl,
    participantAge: metadata.participantAge ?? metadata.participant?.age ?? null,
    isFavorite: metadata.favorite ?? false,
  };
};

const updateDemoRecordMetadata = async (
  recordsRoot: string,
  recordId: string,
  updater: (metadata: StoredDemoRecordMetadata) => StoredDemoRecordMetadata,
) => {
  const recordDirectory = getRecordDirectory(recordsRoot, recordId);
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
          const recordDirectory = getRecordDirectory(recordsRoot, entry.name);
          const metadata = await readDemoRecordMetadata(recordDirectory);

          if (metadata.status !== "success" || !metadata.files?.image || !metadata.lyrics) {
            return null;
          }

          return buildDemoRecordSummary(entry.name, metadata);
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
  const recordDirectory = getRecordDirectory(recordsRoot, recordId);
  const metadata = await readDemoRecordMetadata(recordDirectory);
  const fileName = metadata.files?.[fileType];

  if (!fileName) {
    sendJson(response, 404, { error: "Demo record file not found" });
    return;
  }

  const filePath = path.resolve(recordDirectory, fileName);

  if (!isPathInside(recordDirectory, filePath)) {
    throw new Error("Invalid demo record file path");
  }

  const file = await fs.readFile(filePath);
  response.statusCode = 200;
  response.setHeader("Content-Type", metadata.mimeTypes?.[fileType] ?? "application/octet-stream");
  response.setHeader("Cache-Control", "no-store");
  response.end(file);
};

const createDemoRecordMiddleware =
  (recordsRoot: string) => async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (!request.url?.startsWith("/api/demo-records")) {
      next();
      return;
    }

    const requestUrl = new URL(request.url, "http://localhost");
    const pathParts = requestUrl.pathname.split("/").filter(Boolean);
    const recordId = pathParts.length >= 3 ? decodeURIComponent(pathParts[2]) : null;
    const fileType = pathParts.length >= 4 ? pathParts[3] : null;

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
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
          const recordDirectory = getRecordDirectory(recordsRoot, recordId);
          const metadata = await readDemoRecordMetadata(recordDirectory);

          if (metadata.status !== "success" || !metadata.lyrics) {
            sendJson(response, 404, { error: "Demo record not found" });
            return;
          }

          sendJson(response, 200, {
            ...buildDemoRecordSummary(recordId, metadata),
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
        sendJson(response, 500, { error: message });
      }
      return;
    }

    if (request.method === "DELETE" && recordId && pathParts.length === 3) {
      try {
        const recordDirectory = getRecordDirectory(recordsRoot, recordId);
        await fs.rm(recordDirectory, { recursive: true, force: true });
        sendJson(response, 200, { recordId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete demo record";
        sendJson(response, 500, { error: message });
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

        sendJson(response, 200, {
          recordId,
          isFavorite: nextMetadata.favorite ?? false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update demo record";
        sendJson(response, 500, { error: message });
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
      const audio = payload.audioDataUri ? parseDataUri(payload.audioDataUri) : null;
      const savedAt = new Date().toISOString();
      const timestamp = savedAt.replace(/[:.]/g, "-");
      const title = (metadata.lyrics as { title?: unknown } | undefined)?.title;
      const status = metadata.status === "error" ? "error" : "success";
      const recordId = `${timestamp}_${status}_${sanitizePathPart(title)}_${randomUUID().slice(0, 8)}`;
      const recordDirectory = path.join(recordsRoot, recordId);
      const files: Record<string, string> = {
        image: "input.png",
      };

      await fs.mkdir(recordDirectory, { recursive: true });
      await fs.writeFile(path.join(recordDirectory, files.image), image.buffer);

      if (audio) {
        files.audio = getAudioFileName(audio.mimeType);
        await fs.writeFile(path.join(recordDirectory, files.audio), audio.buffer);
      }

      await fs.writeFile(
        path.join(recordDirectory, "metadata.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            recordId,
            savedAt,
            status,
            files,
            mimeTypes: {
              image: image.mimeType,
              audio: audio?.mimeType ?? null,
            },
            ...metadata,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      sendJson(response, 201, {
        recordId,
        directory: recordDirectory,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save demo record";
      sendJson(response, 500, { error: message });
    }
  };

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const isDev = mode === "development";
  const demoRecordsDir = env.DEMO_RECORDS_DIR ? path.resolve(env.DEMO_RECORDS_DIR) : DEFAULT_DEMO_RECORDS_DIR;

  return {
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
          server.middlewares.use(createGeminiMiddleware(env));
          server.middlewares.use(createDemoRecordMiddleware(demoRecordsDir));
        },
        configurePreviewServer(server) {
          server.middlewares.use(createGeminiMiddleware(env));
          server.middlewares.use(createDemoRecordMiddleware(demoRecordsDir));
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
