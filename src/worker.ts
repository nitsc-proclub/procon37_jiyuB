import type { DrawingData, LyricsResponse, Phase1LyricsResponse, StrokeGroup } from "../types";
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

type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_MODEL_CANDIDATES?: string;
  GEMINI_MODEL_SUB?: string;
  LYRICS_PIPELINE_MODE?: string;
  GEMINI_VISION_MODEL?: string;
  LYRICS_BASE_MODEL?: string;
  LYRICS_CANDIDATE_COUNT?: string;
  DRAWING_ANALYSIS_SCHEMA_VERSION?: string;
  LYRICS_PROMPT_VERSION?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_EXPECTED_HOSTNAME?: string;
};

type ErrorStage = "request" | "config" | "turnstile" | "gemini";
type HttpError = Error & {
  status: number;
  code?: string;
  stage?: ErrorStage;
  turnstileErrorCodes?: string[];
};

const MAX_REQUEST_BYTES = 15 * 1024 * 1024;
const MAX_TURNSTILE_TOKEN_LENGTH = 2048;
const TURNSTILE_ACTION = "generate-ekaki-uta";
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_SITEVERIFY_TIMEOUT_MS = 8_000;
const MODEL_LIST_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const DEFAULT_VISION_MODEL = "gemini-3.7-flash";
const DEFAULT_LYRICS_BASE_MODEL = "gemini-3.5-flash";
const DEFAULT_SCHEMA_VERSION = "1";
let modelListCache: { expiresAt: number; names: string[] } | null = null;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
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
  const promptVersion = env.LYRICS_PROMPT_VERSION?.trim() || DEFAULT_SCHEMA_VERSION;
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
  const candidates = normalizeLyricsCandidates(JSON.parse(candidatesText), strokeGroups).map((candidate) => ({ ...candidate, modelName: lyricsModel }));
  const selectedCandidate = candidates.find((candidate) => candidate.candidateId === "candidate-a") ?? candidates[0];
  if (!selectedCandidate) throw new Error("No valid lyrics candidate");
  return {
    pipelineMode: "phase1",
    drawingAnalysis,
    candidates,
    selectedCandidateId: selectedCandidate.candidateId,
    modelInfo: { drawingAnalysis: visionModel, lyricsGeneration: lyricsModel },
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

const handleGemini = async (request: Request, env: Env) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) return json({ error: "描画データが大きすぎます。" }, 413);

  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_REQUEST_BYTES) return json({ error: "描画データが大きすぎます。" }, 413);
    let payload: { drawingData?: unknown; turnstileToken?: unknown };
    try {
      payload = JSON.parse(new TextDecoder().decode(body)) as { drawingData?: unknown; turnstileToken?: unknown };
    } catch {
      throw httpError("リクエストの形式が正しくありません。", 400);
    }
    const drawingData = assertDrawingData(payload.drawingData);
    await verifyTurnstile(request, assertTurnstileToken(payload.turnstileToken), env);
    return json(await generateEkakiUta(drawingData, env));
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/gemini/generate-ekaki-uta") return handleGemini(request, env);
    return env.ASSETS.fetch(request);
  },
};
