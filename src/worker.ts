import type { DrawingData, LyricsResponse, StrokeGroup } from "../types";

type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_MODEL_CANDIDATES?: string;
  GEMINI_MODEL_SUB?: string;
};

type HttpError = Error & { status: number };

const MAX_REQUEST_BYTES = 15 * 1024 * 1024;
const MODEL_LIST_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_MODEL = "gemini-2.5-flash-lite";
let modelListCache: { expiresAt: number; names: string[] } | null = null;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const httpError = (message: string, status: number): HttpError => Object.assign(new Error(message), { status });

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

const buildPrompt = (strokeGroups: StrokeGroup[]) => {
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

const responseSchema = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    lines: { type: "ARRAY", items: { type: "STRING" } },
    singingKanaLines: { type: "ARRAY", items: { type: "STRING" } },
    identifiedObject: { type: "STRING" },
    lineStrokeMappings: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          lineIndex: { type: "INTEGER" },
          strokeGroupIds: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["lineIndex", "strokeGroupIds"],
      },
    },
  },
  required: ["title", "lines", "singingKanaLines", "identifiedObject", "lineStrokeMappings"],
};

const normalizeAndValidate = (value: unknown, strokeGroups: StrokeGroup[]): LyricsResponse => {
  if (!value || typeof value !== "object") throw new Error("Gemini の応答形式が正しくありません。");
  const result = value as LyricsResponse;
  if (!Array.isArray(result.lines) || result.lines.length === 0 || !Array.isArray(result.singingKanaLines) || result.singingKanaLines.length !== result.lines.length) {
    throw new Error("Gemini の歌詞形式が正しくありません。");
  }
  if (typeof result.title !== "string" || typeof result.identifiedObject !== "string") throw new Error("Gemini の歌詞形式が正しくありません。");

  const validIds = new Set(strokeGroups.map((group) => group.id));
  const usedIds = new Set<string>();
  const mappings = Array.isArray(result.lineStrokeMappings) ? result.lineStrokeMappings : [];
  result.lineStrokeMappings = result.lines.map((_, lineIndex) => {
    const source = mappings.find((mapping) => mapping?.lineIndex === lineIndex);
    const ids = Array.isArray(source?.strokeGroupIds) ? source.strokeGroupIds : [];
    return { lineIndex, strokeGroupIds: ids.filter((id) => typeof id === "string" && validIds.has(id) && !usedIds.has(id) && (usedIds.add(id), true)) };
  });
  return result;
};

const isRetriableStatus = (status: number) => status === 404 || status === 408 || status === 429 || status >= 500;

const generateLyrics = async (drawingData: DrawingData, env: Env) => {
  if (!env.GEMINI_API_KEY) throw httpError("Gemini API の設定がまだ完了していません。", 500);
  const imageMatch = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(drawingData.imageUri);
  if (!imageMatch) throw httpError("画像データが正しくありません。", 400);
  const [, mimeType, base64Image] = imageMatch;
  const strokeGroups = getStrokeGroups(drawingData);
  const requestBody = {
    contents: [{ parts: [{ text: buildPrompt(strokeGroups) }, { inlineData: { mimeType, data: base64Image } }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema },
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
        throw new Error(`Gemini request failed (${response.status})`);
      }
      const payload = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
      if (!text) throw new Error("Gemini の応答が空でした。");
      return { ...normalizeAndValidate(JSON.parse(text), strokeGroups), modelName: model };
    } catch (error) {
      if (index < candidates.length - 1 && !(error instanceof SyntaxError)) continue;
      throw error;
    }
  }
  throw new Error("Gemini の歌詞生成に失敗しました。");
};

const handleGemini = async (request: Request, env: Env) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) return json({ error: "描画データが大きすぎます。" }, 413);

  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_REQUEST_BYTES) return json({ error: "描画データが大きすぎます。" }, 413);
    const payload = JSON.parse(new TextDecoder().decode(body)) as { drawingData?: unknown };
    return json(await generateLyrics(assertDrawingData(payload.drawingData), env));
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 500;
    const message = error instanceof Error && status < 500 ? error.message : "絵描き歌の生成に失敗しました。もう一度試してください。";
    // Do not log the request body, image data, prompt, or API key.
    if (status >= 500) console.error("Gemini generation failed", error instanceof Error ? error.message : "unknown error");
    return json({ error: message }, status);
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/gemini/generate-ekaki-uta") return handleGemini(request, env);
    return env.ASSETS.fetch(request);
  },
};
