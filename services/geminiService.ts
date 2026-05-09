import { GoogleGenAI, Type } from "@google/genai";
import { DrawingData, LyricsResponse } from "../types";

const DEFAULT_MODEL_NAME = "gemini-2.5-flash-lite";

const isHighDemandError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("503") || message.includes("high demand") || message.includes("overloaded");
};

const buildStrokeDescriptions = (drawingData: DrawingData) =>
  drawingData.strokes.map((stroke, index) => {
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

export const generateEkakiUta = async (drawingData: DrawingData): Promise<LyricsResponse> => {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || DEFAULT_MODEL_NAME;
  const subModelName = process.env.GEMINI_MODEL_SUB;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY が設定されていません。.env.local を確認してください。");
  }

  const ai = new GoogleGenAI({ apiKey });
  const base64Image = drawingData.imageUri.split(",")[1];
  const strokeDescriptions = buildStrokeDescriptions(drawingData);

  const prompt = `
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

    if (!Array.isArray(result.lines) || result.lines.length === 0) {
      throw new Error("歌詞の生成結果が空でした。");
    }

    if (!Array.isArray(result.singingKanaLines) || result.singingKanaLines.length !== result.lines.length) {
      throw new Error("歌声合成向けの歌詞が正しく生成されませんでした。");
    }

    return {
      ...result,
      modelName: targetModelName,
    };
  };

  try {
    try {
      return await generateWithModel(modelName);
    } catch (primaryError) {
      const canFallback =
        subModelName && subModelName !== modelName && isHighDemandError(primaryError);

      if (!canFallback) {
        throw primaryError;
      }

      if (import.meta.env.DEV) {
        console.warn(`Gemini primary model failed with high demand. Retrying with ${subModelName}.`, primaryError);
      }

      return await generateWithModel(subModelName);
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error("Gemini API Error:", error);
    }

    if (error instanceof Error) {
      if (error.message.includes("API key")) {
        throw new Error("APIキーが無効です。.env.local を確認してください。");
      }

      if (error.message.includes("429") || error.message.includes("quota")) {
        throw new Error("Gemini API の利用上限に達しました。時間を置いてから再試行してください。");
      }

      if (error.message.includes("network") || error.message.includes("fetch")) {
        throw new Error("ネットワーク接続に失敗しました。インターネット接続を確認してください。");
      }

      throw error;
    }

    throw new Error("絵かき歌の生成に失敗しました。もう一度試してください。");
  }
};
