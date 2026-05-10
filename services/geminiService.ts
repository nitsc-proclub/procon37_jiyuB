import { DrawingData, LyricsResponse } from "../types";

type GenerateEkakiUtaResponse = LyricsResponse | { error?: string };

const isLyricsResponse = (value: GenerateEkakiUtaResponse): value is LyricsResponse =>
  "title" in value && "lines" in value && "identifiedObject" in value && Array.isArray(value.lines);

const parseErrorResponse = async (response: Response) => {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === "string" ? payload.error : null;
  } catch {
    return null;
  }
};

export const generateEkakiUta = async (drawingData: DrawingData): Promise<LyricsResponse> => {
  const response = await fetch("/api/gemini/generate-ekaki-uta", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ drawingData }),
  });

  if (!response.ok) {
    throw new Error((await parseErrorResponse(response)) ?? "絵かき歌の生成に失敗しました。もう一度試してください。");
  }

  const result = (await response.json()) as GenerateEkakiUtaResponse;

  if (!isLyricsResponse(result)) {
    throw new Error(result.error ?? "絵かき歌の生成に失敗しました。もう一度試してください。");
  }

  return result;
};
