import type { DrawingAnalysis, DrawingAnalysisObjectCandidate, DrawingAnalysisPart, LyricsCandidate, LyricsResponse, StrokeGroup } from "../types";

type SchemaTypes<T extends string> = {
  OBJECT: T;
  ARRAY: T;
  STRING: T;
  INTEGER: T;
};

const MAX_ANALYSIS_OBJECT_CANDIDATES = 5;
const MAX_ANALYSIS_PARTS = 64;
const MAX_ANALYSIS_TEXT_LENGTH = 160;
const MIN_CANDIDATE_LYRIC_LINES = 4;
const MAX_CANDIDATE_LYRIC_LINES = 5;
const MAX_CANDIDATE_DISPLAY_LINE_CHARACTERS = 18;
const MAX_CANDIDATE_SINGING_LINE_CHARACTERS = 22;
export const DRAWING_ANALYSIS_SCHEMA_VERSION = 1;
const candidateIds = new Set<string>(["candidate-a", "candidate-b"]);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value: unknown, maxLength = MAX_ANALYSIS_TEXT_LENGTH) =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength ? value.trim() : null;

const boundedCandidateLine = (value: unknown, maxCharacters: number) => {
  // The visible/voiced character budget intentionally ignores whitespace.
  // Keep a separate hard cap to avoid accepting unbounded padding from a model.
  const normalized = nonEmptyString(value, MAX_ANALYSIS_TEXT_LENGTH);
  return normalized !== null && normalized.replace(/\s/g, "").length <= maxCharacters ? normalized : null;
};

export const parseInlineImage = (imageUri: string) => {
  const imageMatch = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(imageUri);
  return imageMatch ? { mimeType: imageMatch[1], data: imageMatch[2] } : null;
};

/** Returns null for a configured version this release does not understand. */
export const resolveDrawingAnalysisSchemaVersion = (configuredVersion?: string) => {
  const normalized = configuredVersion?.trim();
  return !normalized || normalized === String(DRAWING_ANALYSIS_SCHEMA_VERSION) ? DRAWING_ANALYSIS_SCHEMA_VERSION : null;
};

const formatRawStrokeIndexes = (rawStrokeIndexes: number[]) => rawStrokeIndexes.map((index) => index + 1).join(",");

export const buildStrokeGroupDescriptions = (strokeGroups: StrokeGroup[]) =>
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

/** The pre-existing single-model prompt, retained for the legacy switch and fallback. */
export const buildLegacyLyricsPrompt = (strokeGroups: StrokeGroup[]) => `
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
${buildStrokeGroupDescriptions(strokeGroups).join("\n")}
`;

export const buildDrawingAnalysisPrompt = (strokeGroups: StrokeGroup[], schemaVersion: string) => `
あなたは絵描き歌のために、完成画像と描画順を観察して構造化する役です。歌詞は作らないでください。
画像と stroke group 情報から、見える題材の候補、部品の形と位置、部品に対応する stroke group、描画順をJSONで返してください。
題材は断定しすぎず、候補と low / medium / high の段階的な確からしさを返してください。confidence は確率ではありません。objectCandidates は最も確からしい題材を先頭にして確からしい順に並べてください。先頭候補は後段の歌詞候補A/Bが共有する題材になります。
存在する stroke group id だけを使い、同じ id を複数の部品へ割り当てないでください。parts と drawingOrder は空にしないでください。
schemaVersion: ${schemaVersion}

Stroke group count: ${strokeGroups.length}
Stroke group information:
${buildStrokeGroupDescriptions(strokeGroups).join("\n")}
`;

export const buildLyricsCandidatesPrompt = (drawingAnalysis: DrawingAnalysis, promptVersion: string) => `
あなたは日本語の「絵描き歌」を作る作詞家です。画像やraw strokeは渡されません。次の描画理解JSONだけを根拠に、子どもにも歌いやすい候補A/Bを1回で作ってください。
このA/B比較の目的は「同じ描画理解に対して、どちらがより絵描き歌らしいか」を比べることです。objectCandidates[0].label が共通題材です。候補A/Bで題材を変えたり、別の動物・物として再解釈したり、題材の正しさを競わせたりしないでください。題材名はサーバーが共通で設定するため、identifiedObject は返さないでください。
候補は candidate-a と candidate-b の2件です。各候補は必ず4〜5行にし、表示用 lines と、VOICEVOX用のひらがな中心の singingKanaLines を同じ行数にしてください。表示用の各行は空白を除いて18文字以内、歌唱用の各行は22文字以内にしてください。
singingKanaLines では漢字、英字、数字、句読点、絵文字、ASCII記号を避け、発音どおりの読みを使ってください。例: 「ねこは」→「ねこわ」、「まるを」→「まるお」。
各行は、描く動作・形・位置をそのまま歌える短い言葉にしてください。「〜なので」「〜を表します」「〜してください」のような説明文、理由づけ、長い完成説明は避けてください。候補の違いは、リズム、言葉選び、描く順の見せ方にしてください。
各候補で title、lineStrokeMappings を返してください。lineStrokeMappings は歌詞1行につき1件、drawingAnalysisに存在するgroup idだけを使い、描画順を尊重して同じgroup idを複数行に使わないでください。最後の完成宣言は空配列でも構いません。
promptVersion: ${promptVersion}
DrawingAnalysis JSON:
${JSON.stringify(drawingAnalysis)}
`;

const lyricFieldsSchema = <T extends string>(types: SchemaTypes<T>) => ({
  title: { type: types.STRING },
  lines: { type: types.ARRAY, items: { type: types.STRING } },
  singingKanaLines: { type: types.ARRAY, items: { type: types.STRING } },
  identifiedObject: { type: types.STRING },
  lineStrokeMappings: {
    type: types.ARRAY,
    items: {
      type: types.OBJECT,
      properties: {
        lineIndex: { type: types.INTEGER },
        strokeGroupIds: { type: types.ARRAY, items: { type: types.STRING } },
      },
      required: ["lineIndex", "strokeGroupIds"],
    },
  },
});

/** Candidate output deliberately omits the subject: it is copied from the shared DrawingAnalysis. */
const candidateLyricFieldsSchema = <T extends string>(types: SchemaTypes<T>) => ({
  title: { type: types.STRING },
  lines: { type: types.ARRAY, items: { type: types.STRING }, minItems: MIN_CANDIDATE_LYRIC_LINES, maxItems: MAX_CANDIDATE_LYRIC_LINES },
  singingKanaLines: { type: types.ARRAY, items: { type: types.STRING }, minItems: MIN_CANDIDATE_LYRIC_LINES, maxItems: MAX_CANDIDATE_LYRIC_LINES },
  lineStrokeMappings: {
    type: types.ARRAY,
    items: {
      type: types.OBJECT,
      properties: {
        lineIndex: { type: types.INTEGER },
        strokeGroupIds: { type: types.ARRAY, items: { type: types.STRING } },
      },
      required: ["lineIndex", "strokeGroupIds"],
    },
    minItems: MIN_CANDIDATE_LYRIC_LINES,
    maxItems: MAX_CANDIDATE_LYRIC_LINES,
  },
});

export const createLegacyLyricsResponseSchema = <T extends string>(types: SchemaTypes<T>) => ({
  type: types.OBJECT,
  properties: lyricFieldsSchema(types),
  required: ["title", "lines", "singingKanaLines", "identifiedObject", "lineStrokeMappings"],
});

export const createDrawingAnalysisResponseSchema = <T extends string>(types: SchemaTypes<T>) => ({
  type: types.OBJECT,
  properties: {
    schemaVersion: { type: types.INTEGER },
    objectCandidates: {
      type: types.ARRAY,
      items: {
        type: types.OBJECT,
        properties: { label: { type: types.STRING }, confidence: { type: types.STRING } },
        required: ["label", "confidence"],
      },
    },
    parts: {
      type: types.ARRAY,
      items: {
        type: types.OBJECT,
        properties: {
          id: { type: types.STRING },
          shape: { type: types.STRING },
          position: { type: types.STRING },
          strokeGroupIds: { type: types.ARRAY, items: { type: types.STRING } },
        },
        required: ["id", "shape", "position", "strokeGroupIds"],
      },
    },
    drawingOrder: { type: types.ARRAY, items: { type: types.STRING } },
  },
  required: ["schemaVersion", "objectCandidates", "parts", "drawingOrder"],
});

export const createLyricsCandidatesResponseSchema = <T extends string>(types: SchemaTypes<T>) => ({
  type: types.OBJECT,
  properties: {
    candidates: {
      type: types.ARRAY,
      items: {
        type: types.OBJECT,
        properties: { candidateId: { type: types.STRING }, ...candidateLyricFieldsSchema(types) },
        required: ["candidateId", "title", "lines", "singingKanaLines", "lineStrokeMappings"],
      },
    },
  },
  required: ["candidates"],
});

export const normalizeLyricsResponse = (value: unknown, strokeGroups: StrokeGroup[]): LyricsResponse => {
  if (!isRecord(value)) throw new Error("Gemini の応答形式が正しくありません。");
  const result = value as unknown as LyricsResponse;
  if (!Array.isArray(result.lines) || result.lines.length === 0 || !Array.isArray(result.singingKanaLines) || result.singingKanaLines.length !== result.lines.length) {
    throw new Error("Gemini の歌詞形式が正しくありません。");
  }
  if (typeof result.title !== "string" || typeof result.identifiedObject !== "string") throw new Error("Gemini の歌詞形式が正しくありません。");

  const validIds = new Set(strokeGroups.map((group) => group.id));
  const usedIds = new Set<string>();
  const mappings = Array.isArray(result.lineStrokeMappings) ? result.lineStrokeMappings : [];
  return {
    ...result,
    lineStrokeMappings: result.lines.map((_, lineIndex) => {
      const source = mappings.find((mapping) => mapping?.lineIndex === lineIndex);
      const ids = Array.isArray(source?.strokeGroupIds) ? source.strokeGroupIds : [];
      return { lineIndex, strokeGroupIds: ids.filter((id) => typeof id === "string" && validIds.has(id) && !usedIds.has(id) && (usedIds.add(id), true)) };
    }),
  };
};

export const normalizeDrawingAnalysis = (value: unknown, strokeGroups: StrokeGroup[]): DrawingAnalysis => {
  if (!isRecord(value) || value.schemaVersion !== DRAWING_ANALYSIS_SCHEMA_VERSION || !Array.isArray(value.objectCandidates) || !Array.isArray(value.parts) || !Array.isArray(value.drawingOrder)) {
    throw new Error("描画理解の形式が正しくありません。");
  }

  const objectCandidates: DrawingAnalysisObjectCandidate[] = value.objectCandidates.slice(0, MAX_ANALYSIS_OBJECT_CANDIDATES).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const label = nonEmptyString(candidate.label);
    const confidence = candidate.confidence;
    return label && (confidence === "low" || confidence === "medium" || confidence === "high") ? [{ label, confidence }] : [];
  });
  if (objectCandidates.length === 0) throw new Error("描画理解の題材候補が空です。");

  const validGroupIds = new Set(strokeGroups.map((group) => group.id));
  const usedGroupIds = new Set<string>();
  const usedPartIds = new Set<string>();
  const parts: DrawingAnalysisPart[] = value.parts.slice(0, MAX_ANALYSIS_PARTS).flatMap((part, index) => {
    if (!isRecord(part)) return [];
    const shape = nonEmptyString(part.shape);
    const position = nonEmptyString(part.position);
    if (!shape || !position) return [];
    const requestedId = nonEmptyString(part.id, 64);
    const id = requestedId && /^[a-z0-9_-]+$/i.test(requestedId) && !usedPartIds.has(requestedId) ? requestedId : `part-${index + 1}`;
    if (usedPartIds.has(id)) return [];
    usedPartIds.add(id);
    const strokeGroupIds = (Array.isArray(part.strokeGroupIds) ? part.strokeGroupIds : []).filter(
      (groupId): groupId is string => typeof groupId === "string" && validGroupIds.has(groupId) && !usedGroupIds.has(groupId) && (usedGroupIds.add(groupId), true),
    );
    return [{ id, shape, position, strokeGroupIds }];
  });
  if (parts.length === 0) throw new Error("描画理解の部品が空です。");

  const partsById = new Set(parts.map((part) => part.id));
  const usedOrderIds = new Set<string>();
  const drawingOrder = value.drawingOrder
    .filter((partId): partId is string => typeof partId === "string" && partsById.has(partId) && !usedOrderIds.has(partId) && (usedOrderIds.add(partId), true))
    .concat(parts.map((part) => part.id).filter((partId) => !usedOrderIds.has(partId)));
  if (drawingOrder.length === 0) throw new Error("描画理解の順序が空です。");

  return { schemaVersion: DRAWING_ANALYSIS_SCHEMA_VERSION, objectCandidates, parts, drawingOrder };
};

export const normalizeLyricsCandidates = (value: unknown, strokeGroups: StrokeGroup[], drawingAnalysis: DrawingAnalysis): LyricsCandidate[] => {
  if (!isRecord(value) || !Array.isArray(value.candidates)) throw new Error("歌詞候補の形式が正しくありません。");
  // This is intentionally derived once, rather than accepted from either candidate.
  // A/B is about lyric quality, not a second object-recognition contest.
  const identifiedObject = drawingAnalysis.objectCandidates[0]?.label;
  if (!identifiedObject) throw new Error("描画理解の共通題材がありません。");
  const seenCandidateIds = new Set<string>();
  const candidates = value.candidates.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.candidateId !== "string" || !candidateIds.has(candidate.candidateId) || seenCandidateIds.has(candidate.candidateId)) return [];
    try {
      const title = nonEmptyString(candidate.title, 240);
      if (
        !title ||
        !Array.isArray(candidate.lines) ||
        candidate.lines.length < MIN_CANDIDATE_LYRIC_LINES ||
        candidate.lines.length > MAX_CANDIDATE_LYRIC_LINES ||
        !candidate.lines.every((line) => boundedCandidateLine(line, MAX_CANDIDATE_DISPLAY_LINE_CHARACTERS) !== null) ||
        !Array.isArray(candidate.singingKanaLines) ||
        candidate.singingKanaLines.length !== candidate.lines.length ||
        !candidate.singingKanaLines.every((line) => boundedCandidateLine(line, MAX_CANDIDATE_SINGING_LINE_CHARACTERS) !== null) ||
        !Array.isArray(candidate.lineStrokeMappings) ||
        candidate.lineStrokeMappings.length !== candidate.lines.length
      ) {
        return [];
      }
      const mappedLineIndexes = new Set<number>();
      for (const mapping of candidate.lineStrokeMappings) {
        const lineIndex = isRecord(mapping) ? mapping.lineIndex : null;
        if (
          !isRecord(mapping) ||
          typeof lineIndex !== "number" ||
          !Number.isInteger(lineIndex) ||
          lineIndex < 0 ||
          lineIndex >= candidate.lines.length ||
          mappedLineIndexes.has(lineIndex) ||
          !Array.isArray(mapping.strokeGroupIds) ||
          !mapping.strokeGroupIds.every((groupId) => typeof groupId === "string")
        ) {
          return [];
        }
        mappedLineIndexes.add(lineIndex);
      }
      if (mappedLineIndexes.size !== candidate.lines.length) return [];
      const lyrics = normalizeLyricsResponse(
        {
          ...candidate,
          title,
          identifiedObject,
          lines: candidate.lines.map((line) => (line as string).trim()),
          singingKanaLines: candidate.singingKanaLines.map((line) => (line as string).trim()),
        },
        strokeGroups,
      );
      seenCandidateIds.add(candidate.candidateId);
      return [{ ...lyrics, candidateId: candidate.candidateId } as LyricsCandidate];
    } catch {
      return [];
    }
  });
  if (candidates.length === 0) throw new Error("有効な歌詞候補がありません。");
  return candidates;
};
