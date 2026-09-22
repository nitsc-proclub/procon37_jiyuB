import { GoogleGenAI, Type } from "@google/genai";
import type { IncomingMessage, ServerResponse } from "http";
import { groupStrokes } from "../services/strokeGroupingService";
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
import { resolveLyricsCandidateCount } from "../config/generationConfig";
import { generateSingableLyrics } from "../services/singableLyricsGeneration";
import { resolveSingingBpm, SingingCapacityError } from "../services/melodyService";

const DEFAULT_MODEL_NAME = "gemini-2.5-flash-lite";
const DEFAULT_VISION_MODEL = "gemini-3.7-flash";
const DEFAULT_LYRICS_BASE_MODEL = "gemini-3.5-flash";
const DEFAULT_LYRICS_PROMPT_VERSION = "2";
const MODEL_LIST_CACHE_MS = 10 * 60 * 1000;
const MAX_GEMINI_REQUEST_BYTES = 15 * 1024 * 1024;

type GeminiEnv = {
  VITE_SINGING_BPM?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_MODEL_SUB?: string;
  GEMINI_MODEL_CANDIDATES?: string;
  LYRICS_PIPELINE_MODE?: string;
  GEMINI_VISION_MODEL?: string;
  LYRICS_BASE_MODEL?: string;
  LYRICS_CANDIDATE_COUNT?: string;
  DRAWING_ANALYSIS_SCHEMA_VERSION?: string;
  LYRICS_PROMPT_VERSION?: string;
};

type GeminiModelListItem = {
  name?: string;
  supportedGenerationMethods?: string[];
};

type GeminiModelListResponse = {
  models?: GeminiModelListItem[];
};

type ModelListCache = {
  expiresAt: number;
  modelNames: string[];
};

let modelListCache: ModelListCache | null = null;

class HttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

type ModelAttempt = {
  role: "メイン" | "サブ";
  modelName: string;
  error: unknown;
};

class ModelAttemptsError extends Error {
  constructor(public readonly attempts: ModelAttempt[]) {
    super("Gemini API のモデル呼び出しに失敗しました。");
  }
}

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

      if (size > MAX_GEMINI_REQUEST_BYTES) {
        reject(new HttpError("リクエストが大きすぎます。", 413));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const parseModelList = (value: string | undefined) =>
  (value ?? "")
    .split(/[,\s]+/)
    .map((modelName) => modelName.trim())
    .filter(Boolean);

const uniqueModelNames = (modelNames: string[]) => [...new Set(modelNames)];

const normalizeModelName = (modelName: string) => modelName.replace(/^models\//, "");

const includesModelName = (modelNames: string[], modelName: string) =>
  modelNames.some((candidateModelName) => normalizeModelName(candidateModelName) === normalizeModelName(modelName));

const isCandidateGeminiModel = (modelName: string) => {
  const normalized = normalizeModelName(modelName);
  return (
    normalized.startsWith("gemini-") &&
    !normalized.includes("embedding") &&
    !normalized.includes("image") &&
    !normalized.includes("live") &&
    !normalized.includes("tts") &&
    !normalized.includes("robotics") &&
    !normalized.includes("learnlm") &&
    (normalized.includes("flash") || normalized.includes("pro"))
  );
};

const isDynamicGeminiModel = (modelName: string) => normalizeModelName(modelName).includes("flash");

const getVersionScore = (modelName: string) => {
  const [, version = "0"] = /gemini-(\d+(?:\.\d+)?)/.exec(modelName) ?? [];
  return Number.parseFloat(version) || 0;
};

const scoreModelName = (modelName: string) => {
  const normalized = normalizeModelName(modelName);
  let score = getVersionScore(normalized) * 100;

  if (normalized.includes("-pro")) {
    score += 20;
  }

  if (normalized.includes("-flash")) {
    score += 10;
  }

  if (normalized.includes("preview")) {
    score += 5;
  }

  if (normalized.includes("latest")) {
    score += 4;
  }

  if (normalized.includes("lite")) {
    score -= 15;
  }

  return score;
};

const sortModelNamesByPreference = (modelNames: string[]) =>
  [...modelNames].sort((first, second) => {
    const scoreDifference = scoreModelName(second) - scoreModelName(first);
    return scoreDifference || first.localeCompare(second);
  });

const fetchAvailableModelNames = async (apiKey: string) => {
  const now = Date.now();

  if (modelListCache && modelListCache.expiresAt > now) {
    return modelListCache.modelNames;
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);

  if (!response.ok) {
    throw new Error(`Gemini model list request failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as GeminiModelListResponse;
  const modelNames = uniqueModelNames(
    (payload.models ?? [])
      .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
      .map((model) => (model.name ? normalizeModelName(model.name) : ""))
      .filter(isCandidateGeminiModel),
  );

  modelListCache = {
    expiresAt: now + MODEL_LIST_CACHE_MS,
    modelNames,
  };

  return modelNames;
};

const getExplicitModelCandidates = (env: GeminiEnv) => parseModelList(env.GEMINI_MODEL_CANDIDATES);

const getPrimaryModelCandidates = (env: GeminiEnv) => parseModelList(env.GEMINI_MODEL);

const getFallbackModelCandidates = (env: GeminiEnv) =>
  uniqueModelNames([...parseModelList(env.GEMINI_MODEL_SUB), DEFAULT_MODEL_NAME]);

const getModelCandidates = async (apiKey: string, env: GeminiEnv) => {
  const explicitModelNames = getExplicitModelCandidates(env);
  const primaryModelNames = getPrimaryModelCandidates(env);
  const fallbackModelNames = getFallbackModelCandidates(env);
  const configuredModelNames = uniqueModelNames([...explicitModelNames, ...primaryModelNames, ...fallbackModelNames]);

  try {
    const availableModelNames = await fetchAvailableModelNames(apiKey);
    const explicitAvailableModelNames = explicitModelNames.filter((modelName) =>
      includesModelName(availableModelNames, modelName),
    );
    const primaryAvailableModelNames = primaryModelNames.filter((modelName) =>
      includesModelName(availableModelNames, modelName),
    );
    const fallbackAvailableModelNames = fallbackModelNames.filter((modelName) =>
      includesModelName(availableModelNames, modelName),
    );
    const leadingModelNames = explicitAvailableModelNames.length > 0 ? explicitAvailableModelNames : primaryAvailableModelNames;
    const dynamicModelNames = sortModelNamesByPreference(
      availableModelNames.filter(
        (modelName) =>
          isDynamicGeminiModel(modelName) &&
          !includesModelName(leadingModelNames, modelName) &&
          !includesModelName(fallbackAvailableModelNames, modelName),
      ),
    );

    return uniqueModelNames([...leadingModelNames, ...dynamicModelNames, ...fallbackAvailableModelNames, DEFAULT_MODEL_NAME]);
  } catch (error) {
    console.warn("Gemini model list request failed. Falling back to configured models.", error);
    return configuredModelNames;
  }
};

const isHighDemandError = (error: unknown) => {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("503") || message.includes("high demand") || message.includes("overloaded");
};

const isRetriableModelError = (error: unknown) => {
  const message = getErrorMessage(error).toLowerCase();
  return (
    isHighDemandError(error) ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("socket")
  );
};

const isModelSelectionError = (error: unknown) => {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("404") ||
    message.includes("not found") ||
    message.includes("not supported") ||
    message.includes("model is not") ||
    message.includes("invalid model")
  );
};

const shouldTryNextModel = (error: unknown) => {
  const message = getErrorMessage(error).toLowerCase();

  if (message.includes("api key") || message.includes("429") || message.includes("quota")) {
    return false;
  }

  return isRetriableModelError(error) || isModelSelectionError(error);
};

const formatModelAttemptsError = (error: ModelAttemptsError) =>
  [
    "Gemini API の呼び出しに失敗しました。",
    ...error.attempts.map(
      (attempt) => `${attempt.role}モデル（${attempt.modelName}）: ${getErrorMessage(attempt.error)}`,
    ),
  ].join("\n");

const assertDrawingData = (value: unknown): DrawingData => {
  if (!value || typeof value !== "object") {
    throw new HttpError("描画データが送信されていません。", 400);
  }

  const drawingData = value as Partial<DrawingData>;

  if (typeof drawingData.imageUri !== "string" || !drawingData.imageUri.startsWith("data:image/")) {
    throw new HttpError("画像データが正しくありません。", 400);
  }

  if (!Array.isArray(drawingData.strokes)) {
    throw new HttpError("ストロークデータが正しくありません。", 400);
  }

  return drawingData as DrawingData;
};

const getInlineImage = (imageUri: string) => {
  const inlineImage = parseInlineImage(imageUri);
  if (!inlineImage) {
    throw new HttpError("画像データが正しくありません。", 400);
  }
  return inlineImage;
};

const getStrokeGroups = (drawingData: DrawingData) =>
  Array.isArray(drawingData.strokeGroups) && drawingData.strokeGroups.length > 0
    ? drawingData.strokeGroups
    : groupStrokes(drawingData.strokes);

const toClientError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return "絵描き歌の生成に失敗しました。もう一度試してください。";
  }

  if (error.message.includes("API key")) {
    return "APIキーが無効です。.env.local を確認してください。";
  }

  if (error.message.includes("429") || error.message.includes("quota")) {
    return "Gemini API の利用上限に達しました。時間を置いてから再試行してください。";
  }

  if (error.message.includes("network") || error.message.includes("fetch")) {
    return "ネットワーク接続に失敗しました。インターネット接続を確認してください。";
  }

  return error.message;
};

const generateLegacyEkakiUta = async (drawingData: DrawingData, env: GeminiEnv): Promise<LyricsResponse> => {
  const apiKey = env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new HttpError("GEMINI_API_KEY が設定されていません。.env.local を確認してください。", 500);
  }

  const ai = new GoogleGenAI({ apiKey });
  const modelCandidates = await getModelCandidates(apiKey, env);
  const inlineImage = getInlineImage(drawingData.imageUri);
  const strokeGroups = getStrokeGroups(drawingData);
  const prompt = buildLegacyLyricsPrompt(strokeGroups);

  const generateWithModel = async (targetModelName: string): Promise<LyricsResponse> => generateSingableLyrics(async (feedback) => {
    const response = await ai.models.generateContent({
      model: targetModelName,
      contents: [
        {
          parts: [
            { text: prompt + feedback },
            {
              inlineData: inlineImage,
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: createLegacyLyricsResponseSchema(Type),
      },
    });

    const result = normalizeLyricsResponse(JSON.parse(response.text.trim()), strokeGroups);

    return {
      ...result,
      modelName: targetModelName,
    };
  }, result => [result], resolveSingingBpm(env.VITE_SINGING_BPM));

  const attempts: ModelAttempt[] = [];

  for (const [index, modelName] of modelCandidates.entries()) {
    try {
      return await generateWithModel(modelName);
    } catch (error) {
      attempts.push({ role: index === 0 ? "メイン" : "サブ", modelName, error });

      if (index >= modelCandidates.length - 1 || !shouldTryNextModel(error)) {
        throw new ModelAttemptsError(attempts);
      }

      console.warn(`Gemini model ${modelName} failed. Retrying with ${modelCandidates[index + 1]}.`, error);
    }
  }

  throw new ModelAttemptsError(attempts);
};

const generatePhase1EkakiUta = async (drawingData: DrawingData, env: GeminiEnv): Promise<Phase1LyricsResponse> => {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini API key is unavailable");
  const ai = new GoogleGenAI({ apiKey });
  const inlineImage = getInlineImage(drawingData.imageUri);
  const strokeGroups = getStrokeGroups(drawingData);
  const drawingAnalysisSchemaVersion = resolveDrawingAnalysisSchemaVersion(env.DRAWING_ANALYSIS_SCHEMA_VERSION);
  if (drawingAnalysisSchemaVersion === null) throw new Error("Unsupported drawing analysis schema version");
  const schemaVersion = String(drawingAnalysisSchemaVersion);
  const promptVersion = env.LYRICS_PROMPT_VERSION?.trim() || DEFAULT_LYRICS_PROMPT_VERSION;
  const visionModel = env.GEMINI_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
  const lyricsModel = env.LYRICS_BASE_MODEL?.trim() || DEFAULT_LYRICS_BASE_MODEL;

  const analysisResponse = await ai.models.generateContent({
    model: visionModel,
    contents: [
      {
        parts: [
          { text: buildDrawingAnalysisPrompt(strokeGroups, schemaVersion) },
          { inlineData: inlineImage },
        ],
      },
    ],
    config: { responseMimeType: "application/json", responseSchema: createDrawingAnalysisResponseSchema(Type) },
  });
  const drawingAnalysis = normalizeDrawingAnalysis(JSON.parse(analysisResponse.text.trim()), strokeGroups);

  const candidateCount = resolveLyricsCandidateCount(env.LYRICS_CANDIDATE_COUNT);
  const candidates = await generateSingableLyrics(async (feedback) => {
    const candidatesResponse = await ai.models.generateContent({
      model: lyricsModel,
      // Reuse the structured analysis for retries; do not analyze the image again.
      contents: [{ parts: [{ text: buildLyricsCandidatesPrompt(drawingAnalysis, promptVersion, candidateCount) + feedback }] }],
      config: { responseMimeType: "application/json", responseSchema: createLyricsCandidatesResponseSchema(Type, candidateCount) },
    });
    return normalizeLyricsCandidates(JSON.parse(candidatesResponse.text.trim()), strokeGroups, drawingAnalysis, candidateCount).map((candidate) => ({ ...candidate, modelName: lyricsModel }));
  }, result => result, resolveSingingBpm(env.VITE_SINGING_BPM));
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

const shouldUsePhase1 = (env: GeminiEnv) => {
  return env.LYRICS_PIPELINE_MODE?.trim().toLowerCase() === "phase1";
};

const generateEkakiUta = async (drawingData: DrawingData, env: GeminiEnv): Promise<LyricsResponse | Phase1LyricsResponse> => {
  if (!shouldUsePhase1(env)) return generateLegacyEkakiUta(drawingData, env);
  try {
    return await generatePhase1EkakiUta(drawingData, env);
  } catch (error) {
    if (error instanceof SingingCapacityError) throw error;
    return generateLegacyEkakiUta(drawingData, env);
  }
};

export const createGeminiMiddleware =
  (env: GeminiEnv) => async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (!request.url?.startsWith("/api/gemini/generate-ekaki-uta")) {
      next();
      return;
    }

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    try {
      const payload = JSON.parse(await readRequestBody(request)) as { drawingData?: unknown };
      const drawingData = assertDrawingData(payload.drawingData);
      sendJson(response, 200, await generateEkakiUta(drawingData, env));
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      const message =
        error instanceof HttpError
          ? error.message
          : error instanceof ModelAttemptsError
            ? formatModelAttemptsError(error)
            : toClientError(error);

      if (statusCode >= 500) {
        console.error("Gemini API Error:", error);
      }

      sendJson(response, statusCode, { error: message });
    }
  };
