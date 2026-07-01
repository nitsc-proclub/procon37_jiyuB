import { GoogleGenAI, Type } from "@google/genai";
import type { IncomingMessage, ServerResponse } from "http";
import { groupStrokes } from "../services/strokeGroupingService";
import type { DrawingData, LyricsResponse, StrokeGroup } from "../types";

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

const isHighDemandError = (error: unknown) => {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("503") || message.includes("high demand") || message.includes("overloaded");
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

const getBase64Image = (imageUri: string) => {
  const [, base64Image] = imageUri.split(",", 2);

  if (!base64Image) {
    throw new HttpError("画像データが正しくありません。", 400);
  }

  return base64Image;
};

const getStrokeGroups = (drawingData: DrawingData) =>
  Array.isArray(drawingData.strokeGroups) && drawingData.strokeGroups.length > 0
    ? drawingData.strokeGroups
    : groupStrokes(drawingData.strokes);

const formatRawStrokeIndexes = (rawStrokeIndexes: number[]) => rawStrokeIndexes.map((index) => index + 1).join(",");

const buildStrokeGroupDescriptions = (strokeGroups: StrokeGroup[]) =>
  strokeGroups.map((group) => {
    const width = group.bounds.maxX - group.bounds.minX;
    const height = group.bounds.maxY - group.bounds.minY;
    const centerX = group.bounds.minX + width / 2;
    const centerY = group.bounds.minY + height / 2;

    return [
      `Group ${group.id}`,
      `Raw strokes: ${formatRawStrokeIndexes(group.rawStrokeIndexes)}`,
      `Bounding Box(${Math.round(group.bounds.minX)},${Math.round(group.bounds.minY)} to ${Math.round(group.bounds.maxX)},${Math.round(group.bounds.maxY)})`,
      `Center(${Math.round(centerX)},${Math.round(centerY)})`,
      `Size(${Math.round(width)}x${Math.round(height)})`,
      `Duration: ${group.endTime - group.startTime}ms`,
    ].join(", ");
  });

const buildPrompt = (drawingData: DrawingData) => {
  const strokeGroups = getStrokeGroups(drawingData);
  const strokeGroupDescriptions = buildStrokeGroupDescriptions(strokeGroups);

  return `
あなたは日本語の「絵描き歌」を作る作詞家です。
入力された完成画像と stroke group 情報を見て、子どもにも歌いやすい短い絵描き歌を作ってください。

歌詞ルール:
1. lines は4行程度にしてください。
2. singingKanaLines は lines と同じ行数にしてください。
3. lines は画面表示用なので、自然な日本語の表記にしてください。漢字を使っても構いません。
4. singingKanaLines は VOICEVOX が歌うための読み上げ形です。lines の意味と文脈に沿って、実際に声に出す読みをひらがな中心で正確に書いてください。
5. singingKanaLines では、助詞や同形異音語なども文脈で判断し、発音どおりにしてください。例: 「ねこは」→「ねこわ」、「おうちへ」→「おうちえ」、「まるを」→「まるお」、「三つ」→「みっつ」。
6. singingKanaLines では、漢字、英字、数字、句読点、絵文字、ASCII 記号を避けてください。ただし、スペースと長音記号「ー」は使って構いません。
7. 各行は短く、リズムに乗せやすい自然な文にしてください。
8. title と identifiedObject も返してください。

ストローク対応ルール:
9. lineStrokeMappings を必ず返してください。歌詞1行につき1件です。
10. 各行に、その行を歌っている間に描かれる stroke group id を割り当ててください。
11. 1行には1つ、複数、または0個の stroke group を割り当てられます。
12. 最後の行が「できあがり」「これは○○」のような完成宣言だけなら、strokeGroupIds は空配列で構いません。
13. 存在する group id だけを使ってください。基本的に描画順を尊重し、同じ group id を複数行に割り当てないでください。

Stroke group count: ${strokeGroups.length}
Stroke group information:
${strokeGroupDescriptions.join("\n")}
`;
};

const normalizeLineStrokeMappings = (result: LyricsResponse, strokeGroups: StrokeGroup[]) => {
  const validGroupIds = new Set(strokeGroups.map((group) => group.id));
  const usedGroupIds = new Set<string>();
  const sourceMappings = Array.isArray(result.lineStrokeMappings) ? result.lineStrokeMappings : [];

  result.lineStrokeMappings = result.lines.map((_, lineIndex) => {
    const sourceMapping = sourceMappings.find((mapping) => mapping?.lineIndex === lineIndex);
    const strokeGroupIds = Array.isArray(sourceMapping?.strokeGroupIds) ? sourceMapping.strokeGroupIds : [];

    return {
      lineIndex,
      strokeGroupIds: strokeGroupIds.filter((groupId) => {
        if (typeof groupId !== "string" || !validGroupIds.has(groupId) || usedGroupIds.has(groupId)) {
          return false;
        }

        usedGroupIds.add(groupId);
        return true;
      }),
    };
  });
};

const validateLyricsResponse = (result: LyricsResponse, strokeGroups: StrokeGroup[]) => {
  if (!Array.isArray(result.lines) || result.lines.length === 0) {
    throw new Error("歌詞の生成結果が空でした。");
  }

  if (!Array.isArray(result.singingKanaLines) || result.singingKanaLines.length !== result.lines.length) {
    throw new Error("歌声合成向けの歌詞が正しく生成されませんでした。");
  }

  normalizeLineStrokeMappings(result, strokeGroups);
};

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

const generateEkakiUta = async (drawingData: DrawingData, env: GeminiEnv): Promise<LyricsResponse> => {
  const apiKey = env.GEMINI_API_KEY;
  const modelName = env.GEMINI_MODEL || DEFAULT_MODEL_NAME;
  const subModelName = env.GEMINI_MODEL_SUB;

  if (!apiKey) {
    throw new HttpError("GEMINI_API_KEY が設定されていません。.env.local を確認してください。", 500);
  }

  const ai = new GoogleGenAI({ apiKey });
  const base64Image = getBase64Image(drawingData.imageUri);
  const strokeGroups = getStrokeGroups(drawingData);
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
              description: "歌声合成向けの読み上げ形",
            },
            identifiedObject: { type: Type.STRING, description: "絵から推定したモチーフ" },
            lineStrokeMappings: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  lineIndex: { type: Type.INTEGER },
                  strokeGroupIds: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: ["lineIndex", "strokeGroupIds"],
              },
              description: "歌詞行と stroke group id の対応表",
            },
          },
          required: ["title", "lines", "singingKanaLines", "identifiedObject", "lineStrokeMappings"],
        },
      },
    });

    const result = JSON.parse(response.text.trim()) as LyricsResponse;
    validateLyricsResponse(result, strokeGroups);

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
      throw new ModelAttemptsError([{ role: "メイン", modelName, error: primaryError }]);
    }

    console.warn(`Gemini primary model failed with high demand. Retrying with ${subModelName}.`, primaryError);
    try {
      return await generateWithModel(subModelName);
    } catch (subError) {
      throw new ModelAttemptsError([
        { role: "メイン", modelName, error: primaryError },
        { role: "サブ", modelName: subModelName, error: subError },
      ]);
    }
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
