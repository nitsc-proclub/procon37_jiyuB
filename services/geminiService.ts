import { DrawingData, GeneratedEkakiUtaResult, LyricsCandidate, LyricsResponse, Phase1LyricsResponse } from "../types";
import { appConfig } from "../config/appConfig";

type GenerateEkakiUtaErrorResponse = {
  error?: unknown;
  code?: unknown;
  stage?: unknown;
};

type GenerateEkakiUtaResponse = LyricsResponse | Phase1LyricsResponse | GenerateEkakiUtaErrorResponse;
type GenerationReceiptMetadata = {
  archiveGenerationTicket?: unknown;
  voiceJobCapability?: unknown;
  generationId?: unknown;
  evaluationReceipt?: unknown;
  evaluationReceiptExpiresAt?: unknown;
  voiceGrant?: unknown;
  voiceGrants?: unknown;
};

const isSafeDiagnosticValue = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value);

export class GenerateEkakiUtaError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code: string | null,
    public readonly stage: string | null,
  ) {
    super(message);
    this.name = "GenerateEkakiUtaError";
  }
}

const isLyricsResponse = (value: GenerateEkakiUtaResponse): value is LyricsResponse =>
  "title" in value && "lines" in value && "identifiedObject" in value && Array.isArray(value.lines);

const isPhase1LyricsResponse = (value: GenerateEkakiUtaResponse): value is Phase1LyricsResponse =>
  "pipelineMode" in value &&
  value.pipelineMode === "phase1" &&
  "drawingAnalysis" in value &&
  "candidates" in value &&
  Array.isArray(value.candidates) &&
  "selectedCandidateId" in value &&
  "modelInfo" in value &&
  typeof value.modelInfo === "object" &&
  value.modelInfo !== null &&
  "drawingAnalysis" in value.modelInfo &&
  typeof value.modelInfo.drawingAnalysis === "string" &&
  "lyricsGeneration" in value.modelInfo &&
  typeof value.modelInfo.lyricsGeneration === "string" &&
  "lyricsPromptVersion" in value &&
  typeof value.lyricsPromptVersion === "string" &&
  value.lyricsPromptVersion.trim().length > 0;

const parseErrorResponse = async (response: Response) => {
  try {
    const payload = (await response.json()) as GenerateEkakiUtaErrorResponse;
    return {
      message: typeof payload.error === "string" ? payload.error : null,
      code: isSafeDiagnosticValue(payload.code) ? payload.code : null,
      stage: isSafeDiagnosticValue(payload.stage) ? payload.stage : null,
    };
  } catch {
    return { message: null, code: null, stage: null };
  }
};

const resizeImageForGemini = (imageUri: string, maxDimension: number): Promise<string> => {
  if (maxDimension <= 0 || typeof Image === "undefined" || typeof document === "undefined") {
    return Promise.resolve(imageUri);
  }

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const sourceWidth = image.naturalWidth || image.width;
      const sourceHeight = image.naturalHeight || image.height;
      const largestDimension = Math.max(sourceWidth, sourceHeight);

      if (!sourceWidth || !sourceHeight || largestDimension <= maxDimension) {
        resolve(imageUri);
        return;
      }

      const scale = maxDimension / largestDimension;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext("2d");

      if (!context) {
        resolve(imageUri);
        return;
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      try {
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      } catch {
        resolve(imageUri);
      }
    };
    image.onerror = () => resolve(imageUri);
    image.src = imageUri;
  });
};

const readReceiptMetadata = (value: unknown) => {
  if (!value || typeof value !== "object") return {};
  const metadata = value as GenerationReceiptMetadata;
  const voiceGrants = metadata.voiceGrants && typeof metadata.voiceGrants === "object"
    ? Object.fromEntries(
      (["candidate-a", "candidate-b"] as LyricsCandidate["candidateId"][])
        .flatMap((candidateId) => {
          const grant = (metadata.voiceGrants as Record<string, unknown>)[candidateId];
          return typeof grant === "string" && grant.trim().length > 0 ? [[candidateId, grant] as const] : [];
        }),
    ) as Partial<Record<LyricsCandidate["candidateId"], string>>
    : undefined;
  return {
    ...(typeof metadata.archiveGenerationTicket === "string" ? { archiveGenerationTicket: metadata.archiveGenerationTicket } : {}),
    ...(typeof metadata.voiceJobCapability === "string" ? { voiceJobCapability: metadata.voiceJobCapability } : {}),
    ...(typeof metadata.generationId === "string" ? { generationId: metadata.generationId } : {}),
    ...(typeof metadata.evaluationReceipt === "string" ? { evaluationReceipt: metadata.evaluationReceipt } : {}),
    ...(typeof metadata.evaluationReceiptExpiresAt === "string" ? { evaluationReceiptExpiresAt: metadata.evaluationReceiptExpiresAt } : {}),
    ...(typeof metadata.voiceGrant === "string" && metadata.voiceGrant.trim().length > 0 ? { voiceGrant: metadata.voiceGrant } : {}),
    ...(voiceGrants && Object.keys(voiceGrants).length > 0 ? { voiceGrants } : {}),
  };
};

export const generateEkakiUta = async (drawingData: DrawingData, turnstileToken?: string, generationId?: string): Promise<GeneratedEkakiUtaResult> => {
  const requestDrawingData = {
    ...drawingData,
    imageUri: await resizeImageForGemini(drawingData.imageUri, appConfig.geminiImageMaxDimension),
  };
  const response = await fetch("/api/gemini/generate-ekaki-uta", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ drawingData: requestDrawingData, ...(turnstileToken ? { turnstileToken } : {}), ...(generationId ? { generationId } : {}) }),
  });

  if (!response.ok) {
    const error = await parseErrorResponse(response);
    throw new GenerateEkakiUtaError(
      error.message ?? "絵かき歌の生成に失敗しました。もう一度試してください。",
      response.status,
      error.code,
      error.stage,
    );
  }

  const result = (await response.json()) as GenerateEkakiUtaResponse;

  if (isPhase1LyricsResponse(result)) {
    const selected = result.candidates.find((candidate) => candidate.candidateId === result.selectedCandidateId) ?? result.candidates[0];
    if (!selected) {
      throw new GenerateEkakiUtaError("絵かき歌の生成に失敗しました。もう一度試してください。", response.status, null, null);
    }
    return { lyrics: selected, candidates: result.candidates, drawingAnalysis: result.drawingAnalysis, modelInfo: result.modelInfo, lyricsPromptVersion: result.lyricsPromptVersion, ...readReceiptMetadata(result) };
  }

  if (!isLyricsResponse(result)) {
    throw new GenerateEkakiUtaError(
      typeof result.error === "string" ? result.error : "絵かき歌の生成に失敗しました。もう一度試してください。",
      response.status,
      isSafeDiagnosticValue(result.code) ? result.code : null,
      isSafeDiagnosticValue(result.stage) ? result.stage : null,
    );
  }

  return { lyrics: result, candidates: null, drawingAnalysis: null, modelInfo: null, lyricsPromptVersion: null, ...readReceiptMetadata(result) };
};
