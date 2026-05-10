import { GoogleGenAI, Type } from "@google/genai";
import type { IncomingMessage, ServerResponse } from "http";
import type { DrawingData, LyricsResponse } from "../types";

const DEFAULT_MODEL_NAME = "gemini-2.5-flash-lite";
const MAX_GEMINI_REQUEST_BYTES = 15 * 1024 * 1024;

type GeminiEnv = {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_MODEL_SUB?: string;
};

class HttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
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

const isHighDemandError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("503") || message.includes("high demand") || message.includes("overloaded");
};

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

const getBase64Image = (imageUri: string) => {
  const [, base64Image] = imageUri.split(",", 2);

  if (!base64Image) {
    throw new HttpError("画像データが正しくありません。", 400);
  }

  return base64Image;
};

const buildStrokeDescriptions = (drawingData: DrawingData) =>
  drawingData.strokes.map((stroke, index) => {
    if (!stroke.points.length) {
      return `Stroke ${index + 1}, Empty stroke, Duration: ${stroke.endTime - stroke.startTime}ms`;
    }

    const minX = Math.min(...stroke.points.map((point) => point.x));
    const maxX = Math.max(...stroke.points.map((point) => point.x));
    const minY = Math.min(...stroke.points.map((point) => point.y));
    const maxY = Math.max(...stroke.points.map((point) => point.y));

    return [
      `Stroke ${index + 1}`,
      `Bounding Box(${Math.round(minX)},${Math.round(minY)} to ${Math.round(maxX)},${Math.round(maxY)})`,
      `Duration: ${stroke.endTime - stroke.startTime}ms`,
    ].join(", ");
  });

const buildPrompt = (drawingData: DrawingData) => {
  const strokeDescriptions = buildStrokeDescriptions(drawingData);

  return `
あなたは日本語の絵かき歌を作る作詞家です。
入力された絵とストローク情報を見て、子ども向けの短い絵かき歌を作ってください。

出力ルール:
1. 4〜6行の歌詞にしてください。
2. 歌詞とは別に、歌声合成向けのひらがな行も用意してください。
3. singingKanaLines は lines と同じ行数にし、漢字や英字を使わず、ひらがな・ー・っ・ゃゅょ・句読点程度にしてください。
4. 各行は短めで、リズムに乗せやすい自然な文章にしてください。
5. title は楽しいタイトル、identifiedObject は何の絵に見えたかを簡潔に書いてください。

ストローク数: ${drawingData.strokes.length}
ストローク情報:
${strokeDescriptions.join("\n")}
`;
};

const validateLyricsResponse = (result: LyricsResponse) => {
  if (!Array.isArray(result.lines) || result.lines.length === 0) {
    throw new Error("歌詞の生成結果が空でした。");
  }

  if (!Array.isArray(result.singingKanaLines) || result.singingKanaLines.length !== result.lines.length) {
    throw new Error("歌声合成向けの歌詞が正しく生成されませんでした。");
  }
};

const toClientError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return "絵かき歌の生成に失敗しました。もう一度試してください。";
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

const generateEkakiUta = async (drawingData: DrawingData, env: GeminiEnv): Promise<LyricsResponse> => {
  const apiKey = env.GEMINI_API_KEY;
  const modelName = env.GEMINI_MODEL || DEFAULT_MODEL_NAME;
  const subModelName = env.GEMINI_MODEL_SUB;

  if (!apiKey) {
    throw new HttpError("GEMINI_API_KEY が設定されていません。.env.local を確認してください。", 500);
  }

  const ai = new GoogleGenAI({ apiKey });
  const base64Image = getBase64Image(drawingData.imageUri);
  const prompt = buildPrompt(drawingData);

  const generateWithModel = async (targetModelName: string) => {
    const response = await ai.models.generateContent({
      model: targetModelName,
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/png",
                data: base64Image,
              },
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING, description: "歌のタイトル" },
            lines: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "表示用の歌詞",
            },
            singingKanaLines: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "歌声合成向けのひらがな歌詞",
            },
            identifiedObject: { type: Type.STRING, description: "絵から推定したモチーフ" },
          },
          required: ["title", "lines", "singingKanaLines", "identifiedObject"],
        },
      },
    });

    const result = JSON.parse(response.text.trim()) as LyricsResponse;
    validateLyricsResponse(result);

    return {
      ...result,
      modelName: targetModelName,
    };
  };

  try {
    return await generateWithModel(modelName);
  } catch (primaryError) {
    const canFallback = subModelName && subModelName !== modelName && isHighDemandError(primaryError);

    if (!canFallback) {
      throw primaryError;
    }

    console.warn(`Gemini primary model failed with high demand. Retrying with ${subModelName}.`, primaryError);
    return generateWithModel(subModelName);
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
      const message = error instanceof HttpError ? error.message : toClientError(error);

      if (statusCode >= 500) {
        console.error("Gemini API Error:", error);
      }

      sendJson(response, statusCode, { error: message });
    }
  };
