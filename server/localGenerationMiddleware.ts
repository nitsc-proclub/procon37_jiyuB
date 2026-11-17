import OpenAI from "openai";
import type { ReasoningEffort } from "openai/resources/shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createGeminiMiddleware } from "./geminiMiddleware";
import { groupStrokes } from "../services/strokeGroupingService";
import { buildLegacyLyricsPrompt, createLegacyLyricsResponseSchema, normalizeLyricsResponse, parseInlineImage } from "../services/lyricsPipeline";
import { generateSingableLyrics } from "../services/singableLyricsGeneration";
import { resolveSingingBpm, SingingCapacityError } from "../services/melodyService";
import type { DrawingData } from "../types";

type Env = Record<string, string | undefined>;
const DEFAULT_MODEL = "gpt-6.1-terra";
const ENDPOINT = "/api/gemini/generate-ekaki-uta";
const MAX_BYTES = 15 * 1024 * 1024;

class LocalError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Preserve the shared schema's constraints, adding OpenAI's strict object rules.
export const strictSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(strictSchema);
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, strictSchema(child)]));
  if (result.type === "object") result.additionalProperties = false;
  return result;
};
const schema = strictSchema(createLegacyLyricsResponseSchema({ OBJECT: "object", ARRAY: "array", STRING: "string", INTEGER: "integer" })) as Record<string, unknown>;

export const getLocalGenerationConfig = (env: Env) => {
  const provider = env.AI_PROVIDER?.trim().toLowerCase() || "gemini";
  return {
    provider,
    model: provider === "openai" ? env.OPENAI_MODEL?.trim() || DEFAULT_MODEL : env.GEMINI_MODEL?.trim() || "gemini-4-hydrogen",
    keyConfigured: Boolean((provider === "openai" ? env.OPENAI_API_KEY : env.GEMINI_API_KEY)?.trim()),
    pipelineMode: env.LYRICS_PIPELINE_MODE?.trim().toLowerCase() || "legacy",
  };
};

export const generateOpenAILyrics = async (drawing: DrawingData, env: Env) => {
  const config = getLocalGenerationConfig(env);
  if (!config.keyConfigured) throw new LocalError(503, "OPENAI_API_KEY が未設定です。管理画面の [7] から .env.local に入力し、再起動してください。");
  if (config.pipelineMode !== "legacy") throw new LocalError(400, "OpenAI は現在 legacy 方式のみ対応しています。LYRICS_PIPELINE_MODE=legacy に設定して再起動してください。");
  const effort = env.OPENAI_REASONING_EFFORT?.trim() || "low";
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(effort)) throw new LocalError(400, "OPENAI_REASONING_EFFORT の設定が正しくありません。");
  const image = parseInlineImage(drawing.imageUri);
  if (!image || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)) throw new LocalError(400, "画像データが正しくありません。");
  const groups = drawing.strokeGroups?.length ? drawing.strokeGroups : groupStrokes(drawing.strokes);
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY!.trim(), timeout: 60_000, maxRetries: 0 });
  return generateSingableLyrics(async (feedback) => {
    const response = await client.responses.create({
      model: config.model,
      store: false,
      reasoning: { effort: effort as ReasoningEffort },
      max_output_tokens: 4096,
      input: [{ role: "user", content: [
        { type: "input_text", text: buildLegacyLyricsPrompt(groups) + feedback },
        { type: "input_image", image_url: drawing.imageUri, detail: "auto" },
      ] }],
      text: { format: { type: "json_schema", name: "ekaki_uta", strict: true, schema } },
    });
    if (response.output.some(item => item.type === "message" && item.content.some(part => part.type === "refusal"))) throw new LocalError(422, "OpenAI がこの画像の歌詞生成を受け付けませんでした。絵を変更してお試しください。");
    if (response.status !== "completed" || !response.output_text) throw new LocalError(502, "OpenAI の応答が完了しませんでした。もう一度お試しください。");
    try {
      return { ...normalizeLyricsResponse(JSON.parse(response.output_text), groups), modelName: config.model };
    } catch { throw new LocalError(502, "OpenAI の歌詞形式が正しくありません。もう一度お試しください。"); }
  }, result => [result], resolveSingingBpm(env.VITE_SINGING_BPM));
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};

const readDrawing = async (req: IncomingMessage): Promise<DrawingData> => {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BYTES) throw new LocalError(413, "リクエストが大きすぎます。");
    chunks.push(buffer);
  }
  let drawing: DrawingData;
  try { drawing = JSON.parse(Buffer.concat(chunks).toString("utf8")).drawingData; }
  catch { throw new LocalError(400, "リクエストの形式が正しくありません。"); }
  if (!drawing || typeof drawing.imageUri !== "string" || !Array.isArray(drawing.strokes)) throw new LocalError(400, "描画データが正しくありません。");
  return drawing;
};

export const createLocalGenerationMiddleware = (env: Env) => {
  const gemini = createGeminiMiddleware(env);
  const config = getLocalGenerationConfig(env);
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const pathname = req.url?.split("?")[0];
    if (pathname === "/api/local/generation-config" && req.method === "GET") {
      send(res, 200, config);
      return;
    }
    if (pathname !== ENDPOINT) { next(); return; }
    if (config.provider === "gemini") { await gemini(req, res, next); return; }
    if (req.method !== "POST") { send(res, 405, { error: "Method not allowed" }); return; }
    // The paid local endpoint must not accept requests from another website.
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
      send(res, 403, { error: "別のサイトからの生成リクエストは受け付けません。" }); return;
    }
    try {
      if (config.provider !== "openai") throw new LocalError(503, "AI_PROVIDER は gemini または openai を指定してください。");
      send(res, 200, await generateOpenAILyrics(await readDrawing(req), env));
    } catch (error) {
      let status = 502;
      let message = "OpenAI API に接続できませんでした。接続状況を確認して再試行してください。";
      if (error instanceof LocalError) { status = error.status; message = error.message; }
      else if (error instanceof SingingCapacityError) { status = 422; message = error.message; }
      else if (error instanceof OpenAI.APIError) {
        if (error.status === 401 || error.status === 403) { status = 503; message = "OpenAI のAPIキーまたは利用権限を確認してください。"; }
        else if (error.status === 429) { status = 429; message = "OpenAI の利用上限に達しました。残高と利用制限を確認し、時間を置いて再試行してください。"; }
        else if (error.status === 400 || error.status === 404) { message = "OpenAI のモデルまたは生成設定を確認してください。"; }
      }
      // Never serialize SDK errors: they can contain request headers and credentials.
      send(res, status, { error: message });
    }
  };
};
