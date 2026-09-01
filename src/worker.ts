import type { DrawingData, LyricsCandidate, LyricsResponse, Phase1LyricsResponse, StrokeGroup } from "../types";
import {
  buildDrawingAnalysisPrompt,
  buildLegacyLyricsPrompt,
  buildLyricsCandidatesPrompt,
  createDrawingAnalysisResponseSchema,
  createLegacyLyricsResponseSchema,
  createLyricsCandidatesResponseSchema,
  normalizeDrawingAnalysis,
  normalizeLyricsCandidates,
  normalizeLyricsResponse,
  parseInlineImage,
  resolveDrawingAnalysisSchemaVersion,
} from "../services/lyricsPipeline";
import {
  createEvaluationReceipt,
  evaluationFingerprint,
  DEFAULT_EVALUATION_RECEIPT_TTL_SECONDS,
  EVALUATION_SUBMISSION_MAX_BYTES,
  EvaluationSubmissionError,
  saveEvaluationIdempotently,
  validateEvaluationSubmission,
  verifyEvaluationReceipt,
} from "../services/evaluationSubmissionService";
import {
  EVALUATION_FOLLOW_UP_MAX_BYTES,
  loadStoredEvaluationForFollowUp,
  parseEvaluationFollowUpSubmission,
  saveEvaluationFollowUp,
} from "../services/evaluationFollowUpService";
import {
  VOICEVOX_BACKEND_HEADER,
  VOICEVOX_FALLBACK_HEADER,
  VOICEVOX_REQUEST_MAX_BYTES,
  VOICEVOX_STATUS_TIMEOUT_MS,
  fetchVoicevoxBackend,
  hasConfiguredVoicevoxBackend,
  parseSingingScore,
  parseVoicevoxBackendSelection,
  parseVoicevoxVersion,
  readBoundedResponseText,
  getVoicevoxBackendOrder,
  synthesizeWithVoicevoxFallback,
  type VoicevoxAttemptError,
} from "./voicevoxBackend";
import { createVoicevoxJobCapability, handleVoicevoxJobApi } from "./voicevoxJobApi";
import { consumeVoicevoxJob, voicevoxPoolRpcFromService, type VoicevoxJobQueueMessage, type VoicevoxPoolServiceRpc } from "./voicevoxJobConsumer";
import { issueArchiveGenerationTicket } from "./creationArchiveTicket";
import { handleCreationArchiveRequest, cleanupCreationArchives } from "./creationArchiveApi";

// Production binding types come from Wrangler; optional bindings preserve the
// staging/local variants that intentionally omit remote voice services.
type Env = Pick<Cloudflare.Env, "ASSETS"> & Partial<Omit<Cloudflare.Env, "ASSETS">> & {
  GEMINI_MODEL?: string;
  GEMINI_MODEL_CANDIDATES?: string;
  GEMINI_MODEL_SUB?: string;
  VOICEVOX_INFRASTRUCTURE?: VoicevoxPoolServiceRpc;
};

type ErrorStage = "request" | "config" | "turnstile" | "gemini";
type HttpError = Error & {
  status: number;
  code?: string;
  stage?: ErrorStage;
  turnstileErrorCodes?: string[];
};

const MAX_REQUEST_BYTES = 15 * 1024 * 1024;
const archiveSha256Hex = async (input: string | Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof input === "string" ? new TextEncoder().encode(input) : input)), byte => byte.toString(16).padStart(2, "0")).join("");
const MAX_TURNSTILE_TOKEN_LENGTH = 2048;
const TURNSTILE_ACTION = "generate-ekaki-uta";
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_SITEVERIFY_TIMEOUT_MS = 8_000;
const MODEL_LIST_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_VISION_MODEL = "gemini-3.7-flash";
const DEFAULT_LYRICS_BASE_MODEL = "gemini-3.5-flash";
const DEFAULT_LYRICS_PROMPT_VERSION = "3";
const GENERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOICE_GRANT_TTL_MS = 5 * 60 * 1_000;
const VOICE_GRANT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
let modelListCache: { expiresAt: number; names: string[] } | null = null;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const httpError = (message: string, status: number, code?: string, stage?: ErrorStage): HttpError =>
  Object.assign(new Error(message), { status, code, stage });

// Siteverify error codes are only written to Workers logs for the operator.
// Treat them as untrusted external input anyway, so a malformed response can
// never turn the log into a carrier for a token or another long value.
const isSafeTurnstileErrorCode = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9-]{1,64}$/i.test(value);

const addTurnstileErrorCodes = (error: HttpError, errorCodes: unknown) => {
  if (Array.isArray(errorCodes)) {
    error.turnstileErrorCodes = errorCodes.filter(isSafeTurnstileErrorCode).slice(0, 8);
  }
  return error;
};

const parseModelNames = (value?: string) =>
  (value ?? "")
    .split(",")
    .map((name) => name.trim().replace(/^models\//, ""))
    .filter(Boolean);

const unique = (items: string[]) => [...new Set(items)];

const isFlashModel = (name: string) => name.toLowerCase().includes("flash") && !name.toLowerCase().includes("embedding");

const modelScore = (name: string) => {
  const version = Number.parseFloat(name.match(/gemini-(\d+(?:\.\d+)?)/i)?.[1] ?? "0");
  return version * 100 + (name.includes("lite") ? 0 : 1) - (name.includes("preview") ? 0.1 : 0);
};

const getDynamicModels = async (apiKey: string) => {
  if (modelListCache && modelListCache.expiresAt > Date.now()) return modelListCache.names;

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!response.ok) throw new Error(`Gemini model list request failed (${response.status})`);

  const payload = (await response.json()) as {
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };
  const names = unique(
    (payload.models ?? [])
      .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
      .map((model) => model.name?.replace(/^models\//, "") ?? "")
      .filter(isFlashModel)
      .sort((left, right) => modelScore(right) - modelScore(left)),
  );
  modelListCache = { names, expiresAt: Date.now() + MODEL_LIST_CACHE_MS };
  return names;
};

const getModelCandidates = async (env: Env) => {
  const explicit = parseModelNames(env.GEMINI_MODEL_CANDIDATES);
  if (explicit.length > 0) return explicit;

  const configured = parseModelNames(env.GEMINI_MODEL);
  try {
    return unique([...configured, ...(await getDynamicModels(env.GEMINI_API_KEY!)), ...parseModelNames(env.GEMINI_MODEL_SUB), DEFAULT_MODEL]);
  } catch {
    // Model discovery is an optional convenience. The configured fallback remains usable.
    return unique([...configured, ...parseModelNames(env.GEMINI_MODEL_SUB), DEFAULT_MODEL]);
  }
};

const assertDrawingData = (value: unknown): DrawingData => {
  if (!value || typeof value !== "object") throw httpError("描画データが正しくありません。", 400);
  const drawingData = value as Partial<DrawingData>;
  if (typeof drawingData.imageUri !== "string" || !drawingData.imageUri.startsWith("data:image/")) {
    throw httpError("画像データが正しくありません。", 400);
  }
  if (!Array.isArray(drawingData.strokes)) throw httpError("ストロークデータが正しくありません。", 400);
  return drawingData as DrawingData;
};

const assertTurnstileToken = (value: unknown) => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_TURNSTILE_TOKEN_LENGTH
  ) {
    throw httpError("安全確認の情報が正しくありません。もう一度お試しください。", 400);
  }
  return value;
};

type TurnstileVerification = {
  success?: boolean;
  action?: string;
  hostname?: string;
  "error-codes"?: unknown;
};

const verifyTurnstile = async (request: Request, token: string, env: Env) => {
  const expectedHostname = env.TURNSTILE_EXPECTED_HOSTNAME?.trim().toLowerCase();
  if (!env.TURNSTILE_SECRET || !expectedHostname) {
    // Do not fall back to the request Host header: it is client-controlled and would weaken hostname validation.
    throw httpError("安全確認の設定がまだ完了していません。しばらくしてからもう一度お試しください。", 503, "turnstile-config", "config");
  }

  const formData = new FormData();
  formData.set("secret", env.TURNSTILE_SECRET);
  formData.set("response", token);
  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) formData.set("remoteip", remoteIp);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURNSTILE_SITEVERIFY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(TURNSTILE_SITEVERIFY_URL, { method: "POST", body: formData, signal: controller.signal });
  } catch {
    throw httpError("安全確認サービスを利用できません。しばらくしてからもう一度お試しください。", 503, "turnstile-unavailable", "turnstile");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    let errorCodes: unknown;
    try {
      errorCodes = ((await response.json()) as TurnstileVerification)["error-codes"];
    } catch {
      // The external response body is not otherwise used or logged.
    }
    throw addTurnstileErrorCodes(
      httpError("安全確認サービスを利用できません。しばらくしてからもう一度お試しください。", 503, "turnstile-unavailable", "turnstile"),
      errorCodes,
    );
  }

  let verification: TurnstileVerification;
  try {
    verification = (await response.json()) as TurnstileVerification;
  } catch {
    throw httpError("安全確認サービスを利用できません。しばらくしてからもう一度お試しください。", 503, "turnstile-unavailable", "turnstile");
  }
  if (
    !verification ||
    typeof verification.success !== "boolean" ||
    (verification.action !== undefined && typeof verification.action !== "string") ||
    (verification.hostname !== undefined && typeof verification.hostname !== "string")
  ) {
    throw httpError("安全確認サービスを利用できません。しばらくしてからもう一度お試しください。", 503, "turnstile-unavailable", "turnstile");
  }
  if (!verification.success) {
    throw addTurnstileErrorCodes(
      httpError("安全確認に失敗しました。もう一度お試しください。", 403, "turnstile-rejected", "turnstile"),
      verification["error-codes"],
    );
  }
  if (verification.action !== TURNSTILE_ACTION) {
    throw httpError("安全確認に失敗しました。もう一度お試しください。", 403, "turnstile-action-mismatch", "turnstile");
  }
  if (verification.hostname?.toLowerCase() !== expectedHostname) {
    throw httpError("安全確認に失敗しました。もう一度お試しください。", 403, "turnstile-hostname-mismatch", "turnstile");
  }
};

const getStrokeGroups = (drawingData: DrawingData): StrokeGroup[] => {
  if (Array.isArray(drawingData.strokeGroups) && drawingData.strokeGroups.length > 0) return drawingData.strokeGroups;

  return drawingData.strokes.map((stroke, index) => {
    const points = stroke.points.length > 0 ? stroke.points : [{ x: 0, y: 0, timestamp: stroke.startTime }];
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
      id: `group-${index + 1}`,
      rawStrokeIndexes: [index],
      bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
      startTime: stroke.startTime,
      endTime: stroke.endTime,
      length: 0,
    };
  });
};

const isRetriableStatus = (status: number) => status === 404 || status === 408 || status === 429 || status >= 500;

const generateLegacyLyrics = async (drawingData: DrawingData, env: Env): Promise<LyricsResponse> => {
  if (!env.GEMINI_API_KEY) throw httpError("Gemini API の設定がまだ完了していません。", 503, "gemini-config", "config");
  const inlineImage = parseInlineImage(drawingData.imageUri);
  if (!inlineImage) throw httpError("画像データが正しくありません。", 400);
  const strokeGroups = getStrokeGroups(drawingData);
  const requestBody = {
    contents: [{ parts: [{ text: buildLegacyLyricsPrompt(strokeGroups) }, { inlineData: inlineImage }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: createLegacyLyricsResponseSchema({ OBJECT: "OBJECT", ARRAY: "ARRAY", STRING: "STRING", INTEGER: "INTEGER" }),
    },
  };
  const candidates = await getModelCandidates(env);

  for (const [index, model] of candidates.entries()) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        if (index < candidates.length - 1 && isRetriableStatus(response.status)) continue;
        throw httpError("歌を作るサービスを利用できません。しばらくしてからもう一度お試しください。", 502, "gemini-request", "gemini");
      }
      const payload = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
      if (!text) throw httpError("歌を作るサービスから正しい返事を受け取れませんでした。", 502, "gemini-response", "gemini");
      return { ...normalizeLyricsResponse(JSON.parse(text), strokeGroups), modelName: model };
    } catch (error) {
      if (index < candidates.length - 1 && !(error instanceof SyntaxError)) continue;
      if (error && typeof error === "object" && "status" in error && typeof error.status === "number") throw error;
      throw httpError("歌を作るサービスから正しい返事を受け取れませんでした。", 502, "gemini-response", "gemini");
    }
  }
  throw new Error("Gemini の歌詞生成に失敗しました。");
};

const getGeneratedText = async (model: string, requestBody: unknown, env: Env) => {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) throw new Error(`Gemini request failed (${response.status})`);
  const payload = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!text) throw new Error("Gemini response did not include text");
  return text;
};

const generatePhase1Lyrics = async (drawingData: DrawingData, env: Env): Promise<Phase1LyricsResponse> => {
  if (!env.GEMINI_API_KEY) throw new Error("Gemini API key is unavailable");
  const inlineImage = parseInlineImage(drawingData.imageUri);
  if (!inlineImage) throw new Error("Invalid image data");
  const strokeGroups = getStrokeGroups(drawingData);
  const drawingAnalysisSchemaVersion = resolveDrawingAnalysisSchemaVersion(env.DRAWING_ANALYSIS_SCHEMA_VERSION);
  if (drawingAnalysisSchemaVersion === null) throw new Error("Unsupported drawing analysis schema version");
  const schemaVersion = String(drawingAnalysisSchemaVersion);
  const promptVersion = env.LYRICS_PROMPT_VERSION?.trim() || DEFAULT_LYRICS_PROMPT_VERSION;
  const visionModel = env.GEMINI_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
  const lyricsModel = env.LYRICS_BASE_MODEL?.trim() || DEFAULT_LYRICS_BASE_MODEL;
  const schemaTypes = { OBJECT: "OBJECT", ARRAY: "ARRAY", STRING: "STRING", INTEGER: "INTEGER" } as const;

  const drawingAnalysisText = await getGeneratedText(
    visionModel,
    {
      contents: [
        {
          parts: [
            { text: buildDrawingAnalysisPrompt(strokeGroups, schemaVersion) },
            { inlineData: inlineImage },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json", responseSchema: createDrawingAnalysisResponseSchema(schemaTypes) },
    },
    env,
  );
  const drawingAnalysis = normalizeDrawingAnalysis(JSON.parse(drawingAnalysisText), strokeGroups);
  const candidatesText = await getGeneratedText(
    lyricsModel,
    {
      // The lyrics stage receives only the structured analysis: no image URI or raw stroke data.
      contents: [{ parts: [{ text: buildLyricsCandidatesPrompt(drawingAnalysis, promptVersion) }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: createLyricsCandidatesResponseSchema(schemaTypes) },
    },
    env,
  );
  const candidates = normalizeLyricsCandidates(JSON.parse(candidatesText), strokeGroups, drawingAnalysis).map((candidate) => ({ ...candidate, modelName: lyricsModel }));
  const selectedCandidate = candidates.find((candidate) => candidate.candidateId === "candidate-a") ?? candidates[0];
  if (!selectedCandidate) throw new Error("No valid lyrics candidate");
  return {
    pipelineMode: "phase1",
    drawingAnalysis,
    candidates,
    selectedCandidateId: selectedCandidate.candidateId,
    modelInfo: { drawingAnalysis: visionModel, lyricsGeneration: lyricsModel },
    lyricsPromptVersion: promptVersion,
  };
};

const shouldUsePhase1 = (env: Env) => {
  const candidateCount = env.LYRICS_CANDIDATE_COUNT?.trim();
  return env.LYRICS_PIPELINE_MODE?.trim().toLowerCase() === "phase1" && (candidateCount === undefined || candidateCount === "2");
};

const generateEkakiUta = async (drawingData: DrawingData, env: Env): Promise<LyricsResponse | Phase1LyricsResponse> => {
  if (!shouldUsePhase1(env)) return generateLegacyLyrics(drawingData, env);

  try {
    return await generatePhase1Lyrics(drawingData, env);
  } catch {
    // Preserve the established one-stage experience when either phase is unavailable or malformed.
    return generateLegacyLyrics(drawingData, env);
  }
};

type VoiceGrant = { value: string; expiresAt: string };

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const sha256Hex = async (value: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const issueVoiceGrant = async (env: Env, generationId: string, candidateId?: LyricsCandidate["candidateId"]): Promise<VoiceGrant | null> => {
  if (!env.EVALUATIONS_DB || !hasConfiguredVoicevoxBackend(env)) return null;
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const value = bytesToBase64Url(raw);
  const now = Date.now();
  const expiresAt = now + VOICE_GRANT_TTL_MS;
  await env.EVALUATIONS_DB.prepare(
    "INSERT INTO voicevox_grants (grant_hash, generation_id, candidate_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(await sha256Hex(value), generationId, candidateId ?? null, now, expiresAt).run();
  return { value, expiresAt: new Date(expiresAt).toISOString() };
};

const issueVoiceGrants = async (env: Env, generationId: string, result: LyricsResponse | Phase1LyricsResponse) => {
  try {
    if ("pipelineMode" in result && result.pipelineMode === "phase1") {
      const entries = await Promise.all(result.candidates.map(async (candidate) => [candidate.candidateId, await issueVoiceGrant(env, generationId, candidate.candidateId)] as const));
      const voiceGrants = Object.fromEntries(
        entries
          .filter((entry): entry is [LyricsCandidate["candidateId"], VoiceGrant] => entry[1] !== null)
          .map(([candidateId, grant]) => [candidateId, grant.value]),
      );
      return Object.keys(voiceGrants).length > 0 ? { voiceGrants } : {};
    }
    const voiceGrant = await issueVoiceGrant(env, generationId);
    return voiceGrant ? { voiceGrant: voiceGrant.value } : {};
  } catch {
    // Lyrics remain usable when a secondary voice grant cannot be issued.
    console.warn("Voice grant was not issued", { code: "voice-grant-unavailable" });
    return {};
  }
};

const handleVoicevoxStatus = async (request: Request, env: Env) => {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "同じサイトからのみ確認できます。", code: "invalid-origin" }, 403);
  const backend = new URL(request.url).searchParams.get("backend");
  if (backend !== "vpc" && backend !== "cloud-run") return json({ error: "確認する歌声サーバーを指定してください。", code: "invalid-voice-backend" }, 400);
  // Do not let an unauthenticated status probe start a billed Cloud Run
  // instance. Real synthesis remains protected by a one-time generation grant.
  if (backend === "cloud-run") {
    try {
      getVoicevoxBackendOrder(env, backend);
      return json({ available: true, backend, version: null, latencyMs: null, liveCheck: false });
    } catch {
      return json({ available: false, backend, version: null, latencyMs: null, liveCheck: false });
    }
  }
  const startedAt = Date.now();
  try {
    const response = await fetchVoicevoxBackend(env, backend, "/version", { method: "GET", headers: { Accept: "application/json" } }, VOICEVOX_STATUS_TIMEOUT_MS);
    const version = parseVoicevoxVersion(await readBoundedResponseText(response, 4 * 1024));
    if (!response.ok) {
      console.warn("VOICEVOX status check failed", { backend, responseStatus: response.status });
      return json({ available: false, backend, code: "voice-status-failed" }, 502);
    }
    console.info("VOICEVOX status check completed", { backend, latencyMs: Date.now() - startedAt });
    return json({ available: true, backend, version: version || null, latencyMs: Date.now() - startedAt });
  } catch (error) {
    const failure = error && typeof error === "object" && "status" in error ? error as VoicevoxAttemptError : null;
    console.warn("VOICEVOX status check failed", { backend, code: failure?.code ?? "voice-status-failed" });
    return json({ available: false, backend, code: failure?.code ?? "voice-status-failed" }, failure?.status ?? 503);
  }
};

const isVoicevoxSynthesisPayload = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const handleVoicevoxSynthesis = async (request: Request, env: Env) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin) return json({ error: "同じサイトからのみ利用できます。", code: "invalid-origin" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > VOICEVOX_REQUEST_MAX_BYTES) return json({ error: "歌声データが大きすぎます。", code: "voice-request-too-large" }, 413);
  if (!env.EVALUATIONS_DB) return json({ error: "歌声機能はまだ利用できません。", code: "voice-unavailable" }, 503);

  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > VOICEVOX_REQUEST_MAX_BYTES) return json({ error: "歌声データが大きすぎます。", code: "voice-request-too-large" }, 413);
    const payload = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!isVoicevoxSynthesisPayload(payload) || !Object.keys(payload).every((key) => key === "voiceGrant" || key === "score" || key === "backend") || !Object.prototype.hasOwnProperty.call(payload, "score") || typeof payload.voiceGrant !== "string" || !VOICE_GRANT_PATTERN.test(payload.voiceGrant)) {
      return json({ error: "音声チケットを確認できません。新しい歌を作ってください。", code: "invalid-or-expired-voice-grant" }, 403);
    }
    const voiceGrant = payload.voiceGrant as string;
    const score = parseSingingScore(payload.score);
    const backendSelection = parseVoicevoxBackendSelection(payload.backend);
    // Validate the selected backend before consuming the one-time grant. A
    // missing optional backend is fine (auto mode), but an explicitly
    // unavailable backend should not make the user regenerate lyrics.
    getVoicevoxBackendOrder(env, backendSelection);
    const consumed = await env.EVALUATIONS_DB.prepare(
      "UPDATE voicevox_grants SET consumed_at = ?, score_hash = ? WHERE grant_hash = ? AND expires_at > ? AND consumed_at IS NULL",
    ).bind(Date.now(), await sha256Hex(JSON.stringify(score)), await sha256Hex(voiceGrant), Date.now()).run();
    if (consumed.meta?.changes !== 1) return json({ error: "音声チケットを確認できません。新しい歌を作ってください。", code: "invalid-or-expired-voice-grant" }, 403);

    const { response: synthesisResponse, backend, fallback } = await synthesizeWithVoicevoxFallback(env, backendSelection, score);
    const length = Number(synthesisResponse.headers.get("content-length"));
    return new Response(synthesisResponse.body, {
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "no-store",
        [VOICEVOX_BACKEND_HEADER]: backend,
        [VOICEVOX_FALLBACK_HEADER]: String(fallback),
        ...(Number.isFinite(length) ? { "Content-Length": String(length) } : {}),
      },
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
      const failure = error as VoicevoxAttemptError;
      return json({ error: failure.message, code: failure.code ?? "voice-failed" }, failure.status);
    }
    return json({ error: "歌声の合成に失敗しました。", code: "voice-failed" }, 502);
  }
};

const handleGemini = async (request: Request, env: Env) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) return json({ error: "描画データが大きすぎます。" }, 413);

  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_REQUEST_BYTES) return json({ error: "描画データが大きすぎます。" }, 413);
    let payload: { drawingData?: unknown; turnstileToken?: unknown; generationId?: unknown };
    try {
      payload = JSON.parse(new TextDecoder().decode(body)) as { drawingData?: unknown; turnstileToken?: unknown; generationId?: unknown };
    } catch {
      throw httpError("リクエストの形式が正しくありません。", 400);
    }
    const drawingData = assertDrawingData(payload.drawingData);
    if (payload.generationId !== undefined && (typeof payload.generationId !== "string" || !GENERATION_ID_PATTERN.test(payload.generationId))) {
      throw httpError("評価用の生成識別子が正しくありません。", 400, "invalid-generation-id", "request");
    }
    const generationId = typeof payload.generationId === "string" ? payload.generationId : null;
    await verifyTurnstile(request, assertTurnstileToken(payload.turnstileToken), env);
    const result = await generateEkakiUta(drawingData, env);
    const voiceMetadata = generationId ? await issueVoiceGrants(env, generationId, result) : {};
    const centralStorageEnabled = env.EVALUATION_CENTRAL_STORAGE_ENABLED?.trim().toLowerCase() === "true";
    if (centralStorageEnabled && result && "pipelineMode" in result && result.pipelineMode === "phase1" && generationId && env.EVALUATION_RECEIPT_SECRET) {
      try {
        const configuredTtl = Number(env.EVALUATION_RECEIPT_TTL_SECONDS);
        const ttlSeconds = Number.isFinite(configuredTtl) ? configuredTtl : DEFAULT_EVALUATION_RECEIPT_TTL_SECONDS;
        const receipt = await createEvaluationReceipt(generationId, result, env.EVALUATION_RECEIPT_SECRET, Date.now(), ttlSeconds);
        const extra: { voiceJobCapability?: string; archiveGenerationTicket?: string } = {};
        if (env.VOICEVOX_JOBS_ENABLED?.trim() === "true" && env.VOICEVOX_JOBS && env.TEMPORARY_AUDIO) {
          extra.voiceJobCapability = await createVoicevoxJobCapability(generationId, env.EVALUATION_RECEIPT_SECRET);
        }
        if (env.CREATION_ARCHIVES_ENABLED?.trim() === "true" && env.CREATION_ARCHIVES) {
          const originalImage = parseInlineImage(drawingData.imageUri);
          if (originalImage && ["image/png", "image/webp"].includes(originalImage.mimeType)) {
            const fingerprint = await evaluationFingerprint(result);
            const ticket = await issueArchiveGenerationTicket({
              generationId,
              evaluationFingerprint: fingerprint,
              candidateSha256: await archiveSha256Hex(fingerprint),
              imageSha256: await archiveSha256Hex(Uint8Array.from(atob(originalImage.data), c => c.charCodeAt(0))),
              analysisSha256: await archiveSha256Hex(JSON.stringify({ strokes: drawingData.strokes, strokeGroups: drawingData.strokeGroups ?? [] })),
            }, env.EVALUATION_RECEIPT_SECRET);
            extra.archiveGenerationTicket = ticket.value;
          }
        }
        return json({ ...result, ...voiceMetadata, ...extra, generationId, evaluationReceipt: receipt.value, evaluationReceiptExpiresAt: receipt.expiresAt });
      } catch {
        // A central-storage configuration error must not discard valid lyrics.
        console.warn("Evaluation receipt was not issued", { code: "evaluation-receipt-unavailable" });
      }
    }
    return json({ ...result, ...voiceMetadata });
  } catch (error) {
    const httpFailure =
      typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
        ? (error as HttpError)
        : null;
    const status = httpFailure?.status ?? 500;
    const code = httpFailure?.code ?? "gemini-failed";
    const stage = httpFailure?.stage ?? "gemini";
    const message = error instanceof Error && status < 500 ? error.message : "絵描き歌の生成に失敗しました。もう一度試してください。";
    // Do not log the request body, image data, prompt, API key, or exception text.
    console.warn("Generation request failed", {
      code,
      stage,
      status,
      ...(httpFailure?.turnstileErrorCodes ? { turnstileErrorCodes: httpFailure.turnstileErrorCodes } : {}),
    });
    return json({ error: message, code, stage }, status);
  }
};

const evaluationJson = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

const handleEvaluation = async (request: Request, env: Env) => {
  if (request.method !== "POST") return evaluationJson({ error: "Method not allowed" }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin) return evaluationJson({ error: "同じサイトからのみ保存できます。", code: "invalid-origin" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return evaluationJson({ error: "Content-Type must be application/json" }, 415);
  if (env.EVALUATION_CENTRAL_STORAGE_ENABLED?.trim().toLowerCase() !== "true" || !env.EVALUATIONS_DB || !env.EVALUATION_RECEIPT_SECRET || env.EVALUATION_RECEIPT_SECRET.length < 32) {
    return evaluationJson({ error: "評価の中央保存はまだ利用できません。", code: "evaluation-unavailable" }, 503);
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > EVALUATION_SUBMISSION_MAX_BYTES) return evaluationJson({ error: "評価データが大きすぎます。", code: "evaluation-too-large" }, 413);
  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > EVALUATION_SUBMISSION_MAX_BYTES) return evaluationJson({ error: "評価データが大きすぎます。", code: "evaluation-too-large" }, 413);
    const payload = validateEvaluationSubmission(JSON.parse(new TextDecoder().decode(body)));
    if (!await verifyEvaluationReceipt(payload.evaluationReceipt, payload.generationId, payload, env.EVALUATION_RECEIPT_SECRET)) {
      return evaluationJson({ error: "保存用情報の期限が切れているか、内容が一致しません。", code: "invalid-evaluation-receipt" }, 403);
    }
    const saved = await saveEvaluationIdempotently(env.EVALUATIONS_DB, payload);
    return evaluationJson({ saved: true, duplicate: saved.duplicate, generationId: payload.generationId });
  } catch (error) {
    if (error instanceof EvaluationSubmissionError) return evaluationJson({ error: error.message, code: error.code }, error.status);
    return evaluationJson({ error: "評価を保存できませんでした。", code: "evaluation-save-failed" }, 500);
  }
};

const handleEvaluationFollowUp = async (request: Request, env: Env) => {
  if (request.method !== "POST") return evaluationJson({ error: "Method not allowed" }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin) return evaluationJson({ error: "同じサイトからのみ保存できます。", code: "invalid-origin" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return evaluationJson({ error: "Content-Type must be application/json" }, 415);
  if (env.EVALUATION_CENTRAL_STORAGE_ENABLED?.trim().toLowerCase() !== "true" || !env.EVALUATIONS_DB || !env.EVALUATION_RECEIPT_SECRET || env.EVALUATION_RECEIPT_SECRET.length < 32) {
    return evaluationJson({ error: "追加の回答はまだ送れません。", code: "evaluation-unavailable" }, 503);
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > EVALUATION_FOLLOW_UP_MAX_BYTES) return evaluationJson({ error: "追加の回答が大きすぎます。", code: "evaluation-follow-up-too-large" }, 413);
  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > EVALUATION_FOLLOW_UP_MAX_BYTES) return evaluationJson({ error: "追加の回答が大きすぎます。", code: "evaluation-follow-up-too-large" }, 413);
    const followUp = parseEvaluationFollowUpSubmission(new TextDecoder().decode(body));
    const base = await loadStoredEvaluationForFollowUp(env.EVALUATIONS_DB, followUp.generationId, followUp.evaluationReceipt);
    if (!await verifyEvaluationReceipt(followUp.evaluationReceipt, followUp.generationId, base, env.EVALUATION_RECEIPT_SECRET)) {
      return evaluationJson({ error: "送信用の情報の期限が切れています。回答はこの端末に残ります。", code: "invalid-evaluation-receipt" }, 403);
    }
    const saved = await saveEvaluationFollowUp(env.EVALUATIONS_DB, base, followUp);
    return evaluationJson({ saved: true, duplicate: saved.duplicate, generationId: followUp.generationId });
  } catch (error) {
    if (error instanceof EvaluationSubmissionError) return evaluationJson({ error: error.message, code: error.code }, error.status);
    return evaluationJson({ error: "追加の回答を保存できませんでした。", code: "evaluation-follow-up-save-failed" }, 500);
  }
};

export default {
  async queue(batch: MessageBatch<VoicevoxJobQueueMessage>, env: Env): Promise<void> {
    // The Cloud Run credential remains only in this Worker. The internal
    // service binding is solely the lease authority, and this path is explicit.
    if (!env.EVALUATIONS_DB || !env.TEMPORARY_AUDIO || !env.VOICEVOX_INFRASTRUCTURE) {
      for (const message of batch.messages) message.retry();
      return;
    }
    for (const message of batch.messages) {
      const infrastructure = env.VOICEVOX_INFRASTRUCTURE;
      const outcome = await consumeVoicevoxJob(message.body, {
        ...env,
        EVALUATIONS_DB: env.EVALUATIONS_DB,
        TEMPORARY_AUDIO: env.TEMPORARY_AUDIO,
        VOICEVOX_BACKEND_POOL: voicevoxPoolRpcFromService(infrastructure),
      }, "cloud-run");
      if (outcome === "ack") message.ack();
      else message.retry();
    }
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/creation-archives" || pathname.startsWith("/api/creation-archives/")) {
      if (!env.EVALUATIONS_DB || !env.CREATION_ARCHIVES || !env.EVALUATION_RECEIPT_SECRET) return evaluationJson({ code: "archives-unavailable" }, 503);
      // Disabling collection must not disable users' ability to delete it.
      if (env.CREATION_ARCHIVES_ENABLED?.trim() !== "true" && request.method !== "DELETE" && request.method !== "GET") return evaluationJson({ code: "archives-unavailable" }, 503);
      return handleCreationArchiveRequest(request, { EVALUATIONS_DB: env.EVALUATIONS_DB, CREATION_ARCHIVES: env.CREATION_ARCHIVES, EVALUATION_RECEIPT_SECRET: env.EVALUATION_RECEIPT_SECRET });
    }
    if (pathname.startsWith("/api/voicevox/jobs/")) {
      if (env.VOICEVOX_JOBS_ENABLED?.trim() !== "true" || !env.EVALUATIONS_DB || !env.TEMPORARY_AUDIO || !env.VOICEVOX_JOBS || !env.VOICEVOX_CLOUD_RUN_JOBS || !env.EVALUATION_RECEIPT_SECRET) return evaluationJson({ code: "voice-jobs-unavailable" }, 503);
      return handleVoicevoxJobApi(request, { EVALUATIONS_DB: env.EVALUATIONS_DB, TEMPORARY_AUDIO: env.TEMPORARY_AUDIO, VOICEVOX_JOB_QUEUES: { vpc: { send: async message => { await env.VOICEVOX_JOBS!.send(message); } }, "cloud-run": { send: async message => { await env.VOICEVOX_CLOUD_RUN_JOBS!.send(message); } } }, EVALUATION_RECEIPT_SECRET: env.EVALUATION_RECEIPT_SECRET, CLOUD_RUN_OVERFLOW_GENERATIONS: env.CLOUD_RUN_OVERFLOW_GENERATIONS });
    }
    if (pathname === "/api/gemini/generate-ekaki-uta") return handleGemini(request, env);
    if (pathname === "/api/voicevox/status") return handleVoicevoxStatus(request, env);
    if (pathname === "/api/voicevox/synthesize") return handleVoicevoxSynthesis(request, env);
    if (pathname === "/api/evaluations") return handleEvaluation(request, env);
    if (pathname === "/api/evaluations/follow-up") return handleEvaluationFollowUp(request, env);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.EVALUATIONS_DB && env.CREATION_ARCHIVES && env.EVALUATION_RECEIPT_SECRET) {
      ctx.waitUntil(cleanupCreationArchives({ EVALUATIONS_DB: env.EVALUATIONS_DB, CREATION_ARCHIVES: env.CREATION_ARCHIVES, EVALUATION_RECEIPT_SECRET: env.EVALUATION_RECEIPT_SECRET }));
    }
  },
} satisfies ExportedHandler<Env>;
