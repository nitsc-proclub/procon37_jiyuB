import { DrawingData, LyricsResponse } from "../types";

type GenerateEkakiUtaErrorResponse = {
  error?: unknown;
  code?: unknown;
  stage?: unknown;
};

type GenerateEkakiUtaResponse = LyricsResponse | GenerateEkakiUtaErrorResponse;

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

export const generateEkakiUta = async (drawingData: DrawingData, turnstileToken?: string): Promise<LyricsResponse> => {
  const response = await fetch("/api/gemini/generate-ekaki-uta", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ drawingData, ...(turnstileToken ? { turnstileToken } : {}) }),
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

  if (!isLyricsResponse(result)) {
    throw new GenerateEkakiUtaError(
      typeof result.error === "string" ? result.error : "絵かき歌の生成に失敗しました。もう一度試してください。",
      response.status,
      isSafeDiagnosticValue(result.code) ? result.code : null,
      isSafeDiagnosticValue(result.stage) ? result.stage : null,
    );
  }

  return result;
};
