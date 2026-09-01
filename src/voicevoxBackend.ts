import type { SingingScore } from "../types";
import { createCloudRunIdToken } from "./cloudRunIdToken";

export const VOICEVOX_REQUEST_MAX_BYTES = 256 * 1024;
export const VOICEVOX_STATUS_TIMEOUT_MS = 10_000;
export const VOICEVOX_BACKEND_HEADER = "X-Voicevox-Backend";
export const VOICEVOX_FALLBACK_HEADER = "X-Voicevox-Fallback";

const VOICEVOX_VPC_ORIGIN = "http://localhost:50021";
const CLOUD_RUN_HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+run\.app$/i;
const VOICEVOX_QUERY_MAX_BYTES = 1024 * 1024;
const VOICEVOX_MAX_NOTES = 512;
const VOICEVOX_MAX_TOTAL_FRAMES = 36_000;
const VOICEVOX_MAX_AUDIO_BYTES = 32 * 1024 * 1024;

export type VoicevoxBackend = "vpc" | "cloud-run";
export type VoicevoxBackendSelection = VoicevoxBackend | "auto";
export type VoicevoxErrorStage = "request" | "config";

export type VoicevoxBackendEnv = {
  VOICEVOX?: { fetch(resource: string | URL | Request, init?: RequestInit): Promise<Response> };
  VOICEVOX_CLOUD_RUN_URL?: string;
  VOICEVOX_GCP_SERVICE_ACCOUNT_JSON?: string;
};

export type VoicevoxAttemptError = Error & {
  status: number;
  code?: string;
  stage?: VoicevoxErrorStage;
  retryable?: boolean;
  responseStatus?: number;
  backend?: VoicevoxBackend;
};

export type VoicevoxBackendDependencies = {
  fetcher?: typeof fetch;
  createIdToken?: (serviceAccountJson: string, audience: string) => Promise<string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const httpError = (message: string, status: number, code?: string, stage?: VoicevoxErrorStage): VoicevoxAttemptError =>
  Object.assign(new Error(message), { status, code, stage });

export const parseSingingScore = (value: unknown): SingingScore => {
  if (!isRecord(value) || !Array.isArray(value.notes) || value.notes.length === 0 || value.notes.length > VOICEVOX_MAX_NOTES) {
    throw httpError("歌声データの形式が正しくありません。", 400, "invalid-voice-score", "request");
  }
  let totalFrames = 0;
  const notes = value.notes.map((note) => {
    if (!isRecord(note) || Object.keys(note).length !== 3 || typeof note.lyric !== "string" || note.lyric.length > 128
      || !(note.key === null || (typeof note.key === "number" && Number.isInteger(note.key) && note.key >= 0 && note.key <= 127))
      || typeof note.frame_length !== "number" || !Number.isInteger(note.frame_length) || note.frame_length < 1 || note.frame_length > VOICEVOX_MAX_TOTAL_FRAMES) {
      throw httpError("歌声データの形式が正しくありません。", 400, "invalid-voice-score", "request");
    }
    totalFrames += note.frame_length;
    return { lyric: note.lyric, key: note.key as number | null, frame_length: note.frame_length };
  });
  if (totalFrames > VOICEVOX_MAX_TOTAL_FRAMES) throw httpError("歌声が長すぎます。", 413, "voice-score-too-long", "request");
  return { notes };
};

export const getCloudRunUrl = (env: VoicevoxBackendEnv) => {
  const value = env.VOICEVOX_CLOUD_RUN_URL?.trim();
  let url: URL | null = null;
  try {
    url = value ? new URL(value) : null;
  } catch {
    url = null;
  }
  if (
    !url
    || url.protocol !== "https:"
    || !CLOUD_RUN_HOST_PATTERN.test(url.hostname)
    || url.port
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw httpError("Google Cloud Runの歌声サーバー設定がまだ完了していません。", 503, "voice-cloud-run-config", "config");
  }
  return url.origin;
};

export const isCloudRunReady = (env: VoicevoxBackendEnv) => {
  if (!env.VOICEVOX_GCP_SERVICE_ACCOUNT_JSON?.trim()) return false;
  try {
    getCloudRunUrl(env);
    return true;
  } catch {
    return false;
  }
};

export const hasConfiguredVoicevoxBackend = (env: VoicevoxBackendEnv) => Boolean(env.VOICEVOX || isCloudRunReady(env));

export const parseVoicevoxBackendSelection = (value: unknown): VoicevoxBackendSelection => {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "vpc" || value === "cloud-run") return value;
  throw httpError("歌声サーバーの指定が正しくありません。", 400, "invalid-voice-backend", "request");
};

export const getVoicevoxBackendOrder = (env: VoicevoxBackendEnv, selection: VoicevoxBackendSelection): VoicevoxBackend[] => {
  if (selection === "vpc") {
    if (!env.VOICEVOX) throw httpError("Cloudflare VPCの歌声サーバー設定がまだ完了していません。", 503, "voice-vpc-config", "config");
    return ["vpc"];
  }
  if (selection === "cloud-run") {
    if (!isCloudRunReady(env)) throw httpError("Google Cloud Runの歌声サーバー設定がまだ完了していません。", 503, "voice-cloud-run-config", "config");
    return ["cloud-run"];
  }

  const order: VoicevoxBackend[] = [];
  if (env.VOICEVOX) order.push("vpc");
  if (isCloudRunReady(env)) order.push("cloud-run");
  if (order.length === 0) throw httpError("歌声サーバーの設定がまだ完了していません。", 503, "voice-server-config", "config");
  return order;
};

const createVoicevoxAttemptError = (
  message: string,
  code: string,
  backend: VoicevoxBackend,
  options: { status?: number; retryable?: boolean; responseStatus?: number } = {},
): VoicevoxAttemptError => Object.assign(
  httpError(message, options.status ?? 502, code, "config"),
  { backend, retryable: options.retryable ?? true, responseStatus: options.responseStatus },
);

const isRetryableVoicevoxResponse = (status: number) => status === 404 || status === 408 || status === 429 || status >= 500;

const fetchVPCVoicevox = async (env: VoicevoxBackendEnv, path: string, init: RequestInit, timeoutMs: number) => {
  if (!env.VOICEVOX) throw httpError("Cloudflare VPCの歌声サーバー設定がまだ完了していません。", 503, "voice-vpc-config", "config");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await env.VOICEVOX.fetch(new URL(path, `${VOICEVOX_VPC_ORIGIN}/`), { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw createVoicevoxAttemptError("Cloudflare VPCの歌声サーバーがタイムアウトしました。", "voice-vpc-timeout", "vpc");
    }
    throw createVoicevoxAttemptError("Cloudflare VPCの歌声サーバーを利用できません。", "voice-vpc-unavailable", "vpc");
  } finally {
    clearTimeout(timeout);
  }
};

const fetchCloudRunVoicevox = async (
  env: VoicevoxBackendEnv,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  { fetcher = fetch, createIdToken = createCloudRunIdToken }: VoicevoxBackendDependencies,
) => {
  const serviceUrl = getCloudRunUrl(env);
  const serviceAccountJson = env.VOICEVOX_GCP_SERVICE_ACCOUNT_JSON?.trim();
  if (!serviceAccountJson) throw httpError("Google Cloud Runの歌声サーバー設定がまだ完了していません。", 503, "voice-cloud-run-config", "config");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const idToken = await createIdToken(serviceAccountJson, serviceUrl);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${idToken}`);
    return await fetcher(new URL(path, `${serviceUrl}/`), { ...init, headers, signal: controller.signal });
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && typeof error.status === "number") throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw createVoicevoxAttemptError("Google Cloud Runの歌声サーバーがタイムアウトしました。", "voice-cloud-run-timeout", "cloud-run");
    }
    throw createVoicevoxAttemptError("Google Cloud Runの歌声サーバーを利用できません。", "voice-cloud-run-unavailable", "cloud-run");
  } finally {
    clearTimeout(timeout);
  }
};

export const fetchVoicevoxBackend = (
  env: VoicevoxBackendEnv,
  backend: VoicevoxBackend,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  dependencies: VoicevoxBackendDependencies = {},
) => backend === "vpc"
  ? fetchVPCVoicevox(env, path, init, timeoutMs)
  : fetchCloudRunVoicevox(env, path, init, timeoutMs, dependencies);

const throwForVoicevoxResponse = (response: Response, backend: VoicevoxBackend, stage: "query" | "synthesis") => {
  if (response.ok) return;
  const retryable = isRetryableVoicevoxResponse(response.status);
  throw createVoicevoxAttemptError(
    stage === "query" ? "歌声の準備に失敗しました。" : "歌声の合成に失敗しました。",
    stage === "query" ? "voice-query-failed" : "voice-synthesis-failed",
    backend,
    { retryable, responseStatus: response.status },
  );
};

const readBoundedResponseBytes = async (
  response: Response,
  maxBytes: number,
  createTooLargeError: () => VoicevoxAttemptError,
) => {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response-too-large");
        throw createTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const limitVoicevoxAudioResponse = (response: Response, backend: VoicevoxBackend) => {
  if (!response.body) throw createVoicevoxAttemptError("歌声の合成に失敗しました。", "voice-synthesis-failed", backend);
  let total = 0;
  const limitedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > VOICEVOX_MAX_AUDIO_BYTES) {
        controller.error(createVoicevoxAttemptError("歌声データが大きすぎます。", "voice-audio-too-large", backend, { retryable: false }));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(limitedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export const synthesizeWithVoicevoxBackend = async (
  env: VoicevoxBackendEnv,
  backend: VoicevoxBackend,
  score: SingingScore,
  dependencies: VoicevoxBackendDependencies = {},
) => {
  const requestInit: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(score),
  };
  const queryResponse = await fetchVoicevoxBackend(env, backend, "/sing_frame_audio_query?speaker=6000", requestInit, 45_000, dependencies);
  throwForVoicevoxResponse(queryResponse, backend, "query");
  const queryLength = Number(queryResponse.headers.get("content-length"));
  if (Number.isFinite(queryLength) && queryLength > VOICEVOX_QUERY_MAX_BYTES) {
    throw createVoicevoxAttemptError("歌声の準備に失敗しました。", "voice-query-too-large", backend, { retryable: false });
  }
  const queryBytes = await readBoundedResponseBytes(
    queryResponse,
    VOICEVOX_QUERY_MAX_BYTES,
    () => createVoicevoxAttemptError("歌声の準備に失敗しました。", "voice-query-too-large", backend, { retryable: false }),
  );
  let query: unknown;
  try {
    query = JSON.parse(new TextDecoder().decode(queryBytes));
  } catch {
    throw createVoicevoxAttemptError("歌声の準備に失敗しました。", "voice-query-invalid", backend);
  }
  if (!isRecord(query)) throw createVoicevoxAttemptError("歌声の準備に失敗しました。", "voice-query-invalid", backend);

  const synthesisResponse = await fetchVoicevoxBackend(env, backend, "/frame_synthesis?speaker=3003", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
  }, 120_000, dependencies);
  throwForVoicevoxResponse(synthesisResponse, backend, "synthesis");
  const length = Number(synthesisResponse.headers.get("content-length"));
  if (Number.isFinite(length) && length > VOICEVOX_MAX_AUDIO_BYTES) {
    throw createVoicevoxAttemptError("歌声データが大きすぎます。", "voice-audio-too-large", backend, { retryable: false });
  }
  return { response: limitVoicevoxAudioResponse(synthesisResponse, backend), backend };
};

export const synthesizeWithVoicevoxFallback = async (
  env: VoicevoxBackendEnv,
  selection: VoicevoxBackendSelection,
  score: SingingScore,
  dependencies: VoicevoxBackendDependencies = {},
) => {
  const order = getVoicevoxBackendOrder(env, selection);
  const failures: VoicevoxAttemptError[] = [];
  for (const [index, backend] of order.entries()) {
    console.info("VOICEVOX synthesis attempt", { backend, selection, priority: index + 1 });
    try {
      const result = await synthesizeWithVoicevoxBackend(env, backend, score, dependencies);
      console.info("VOICEVOX synthesis completed", { backend, selection, fallback: index > 0 });
      return { ...result, fallback: index > 0 };
    } catch (error) {
      const failure = error && typeof error === "object" && "status" in error
        ? error as VoicevoxAttemptError
        : createVoicevoxAttemptError("歌声サーバーを利用できません。", "voice-server-unavailable", backend);
      const normalizedFailure = failure.backend ? failure : Object.assign(failure, { backend });
      failures.push(normalizedFailure);
      console.warn("VOICEVOX synthesis backend failed", {
        backend,
        selection,
        code: normalizedFailure.code ?? "voice-server-unavailable",
        responseStatus: normalizedFailure.responseStatus,
        retryable: normalizedFailure.retryable !== false,
      });
      if (normalizedFailure.retryable === false) throw normalizedFailure;
    }
  }
  throw failures[failures.length - 1] ?? httpError("歌声サーバーを利用できません。", 503, "voice-server-unavailable", "config");
};

export const readBoundedResponseText = async (response: Response, maxBytes: number) => {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = maxBytes - total;
      const chunk = next.value.byteLength > remaining ? next.value.slice(0, remaining) : next.value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < next.value.byteLength) break;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes).trim();
};

export const parseVoicevoxVersion = (value: string) => {
  if (!value) return null;
  try {
    const payload = JSON.parse(value) as unknown;
    if (typeof payload === "string") return payload.trim().slice(0, 256) || null;
    if (isRecord(payload) && typeof payload.version === "string") return payload.version.trim().slice(0, 256) || null;
  } catch {
    // Some Engine versions return a plain text version. Keep that compatible.
  }
  return value.slice(0, 256);
};
