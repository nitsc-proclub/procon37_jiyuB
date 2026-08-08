import { DebugBundleManifest, GenerationTimingPhase } from "../types";
import { DebugBundleArtifacts, sanitizeDebugBundleArtifacts } from "./debugBundleService";

/**
 * Importer for the intentionally small ZIP dialect written by debugBundleService.
 *
 * This is deliberately not a general-purpose ZIP reader.  Supporting only stored
 * (uncompressed) entries means the amount of memory read is known before we parse
 * JSON, and prevents a compressed ZIP bomb from reaching the browser history.
 */
const MAX_BUNDLE_BYTES = 80 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_README_BYTES = 200 * 1024;
const MAX_ENTRIES = 4;
// Drawing timestamps are epoch milliseconds. Keep this safely below Number's
// exact-integer limit while accepting real-world dates beyond 2001.
const MAX_TIMESTAMP_MS = 1_000_000_000_000_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const REQUIRED_ENTRY_NAMES = ["manifest.json", "input.png", "README.txt"] as const;
const OPTIONAL_ENTRY_NAME = "voice.wav";
const ALLOWED_ENTRY_NAMES = new Set<string>([...REQUIRED_ENTRY_NAMES, OPTIONAL_ENTRY_NAME]);
const TIMING_PHASES = new Set<GenerationTimingPhase>(["gemini", "accent", "score", "voicevoxQuery", "voicevoxSynthesis", "finalize"]);
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type ImportedZipEntry = {
  name: string;
  bytes: Uint8Array;
};

function importError(message: string): never {
  throw new Error(`デバッグZIPを読み込めません: ${message}`);
}

const readUint16 = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
const readUint32 = (bytes: Uint8Array, offset: number) =>
  (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;

const assertRange = (bytes: Uint8Array, offset: number, length: number, message: string) => {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    importError(message);
  }
};

const crc32 = (bytes: Uint8Array) => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
};

const decodeEntryName = (bytes: Uint8Array) => {
  try {
    return textDecoder.decode(bytes);
  } catch {
    importError("ファイル名がUTF-8ではありません。");
  }
};

const getEntryLimit = (name: string) => {
  switch (name) {
    case "manifest.json":
      return MAX_MANIFEST_BYTES;
    case "input.png":
      return MAX_IMAGE_BYTES;
    case "voice.wav":
      return MAX_AUDIO_BYTES;
    case "README.txt":
      return MAX_README_BYTES;
    default:
      return 0;
  }
};

const parseStoredZip = (bytes: Uint8Array): Map<string, ImportedZipEntry> => {
  if (bytes.length < 22 || bytes.length > MAX_BUNDLE_BYTES) {
    importError("ファイルサイズが対応範囲外です。");
  }

  // This app never writes ZIP comments. Requiring the EOCD at the exact end
  // rejects appended data and avoids having to search attacker-controlled data.
  const eocdOffset = bytes.length - 22;
  if (readUint32(bytes, eocdOffset) !== 0x06054b50 || readUint16(bytes, eocdOffset + 20) !== 0) {
    importError("対応していないZIP形式です。");
  }

  const disk = readUint16(bytes, eocdOffset + 4);
  const centralDisk = readUint16(bytes, eocdOffset + 6);
  const entriesOnDisk = readUint16(bytes, eocdOffset + 8);
  const entries = readUint16(bytes, eocdOffset + 10);
  const centralSize = readUint32(bytes, eocdOffset + 12);
  const centralOffset = readUint32(bytes, eocdOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries || entries < REQUIRED_ENTRY_NAMES.length || entries > MAX_ENTRIES) {
    importError("分割ZIPまたはファイル数が不正です。");
  }
  assertRange(bytes, centralOffset, centralSize, "中央ディレクトリの範囲が不正です。");
  if (centralOffset + centralSize !== eocdOffset) {
    importError("ZIP内の余分なデータは許可されていません。");
  }

  const parsed: Array<{ name: string; localOffset: number; size: number; checksum: number }> = [];
  let cursor = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    assertRange(bytes, cursor, 46, "中央ディレクトリが途中で終わっています。");
    if (readUint32(bytes, cursor) !== 0x02014b50) importError("中央ディレクトリの形式が不正です。");
    const flags = readUint16(bytes, cursor + 8);
    const method = readUint16(bytes, cursor + 10);
    const checksum = readUint32(bytes, cursor + 16);
    const compressedSize = readUint32(bytes, cursor + 20);
    const uncompressedSize = readUint32(bytes, cursor + 24);
    const nameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    const startDisk = readUint16(bytes, cursor + 34);
    const localOffset = readUint32(bytes, cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    assertRange(bytes, cursor, recordLength, "中央ディレクトリのエントリが不正です。");
    if (flags !== 0 || method !== 0 || compressedSize !== uncompressedSize || extraLength !== 0 || commentLength !== 0 || startDisk !== 0) {
      importError("このZIPはアプリが出力する保存形式ではありません。");
    }
    const name = decodeEntryName(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    if (!ALLOWED_ENTRY_NAMES.has(name) || name.includes("/") || name.includes("\\") || name.includes("..") || parsed.some((entry) => entry.name === name)) {
      importError("ZIP内のファイル名または重複が不正です。");
    }
    if (compressedSize === 0 || compressedSize > getEntryLimit(name)) {
      importError(`${name} のサイズが対応範囲外です。`);
    }
    parsed.push({ name, localOffset, size: compressedSize, checksum });
    cursor += recordLength;
  }
  if (cursor !== eocdOffset) importError("中央ディレクトリのサイズが一致しません。");

  for (const name of REQUIRED_ENTRY_NAMES) {
    if (!parsed.some((entry) => entry.name === name)) importError(`${name} が見つかりません。`);
  }

  // The writer lays local records out contiguously from byte 0. Requiring that
  // layout catches offsets into the central directory and overlapping entries.
  const locals = [...parsed].sort((first, second) => first.localOffset - second.localOffset);
  let expectedOffset = 0;
  const result = new Map<string, ImportedZipEntry>();
  for (const entry of locals) {
    if (entry.localOffset !== expectedOffset) importError("ZIP内のファイル配置が不正です。");
    assertRange(bytes, entry.localOffset, 30, "ローカルファイルヘッダーが不正です。");
    if (readUint32(bytes, entry.localOffset) !== 0x04034b50) importError("ローカルファイルヘッダーが不正です。");
    const version = readUint16(bytes, entry.localOffset + 4);
    const flags = readUint16(bytes, entry.localOffset + 6);
    const method = readUint16(bytes, entry.localOffset + 8);
    const checksum = readUint32(bytes, entry.localOffset + 14);
    const compressedSize = readUint32(bytes, entry.localOffset + 18);
    const uncompressedSize = readUint32(bytes, entry.localOffset + 22);
    const nameLength = readUint16(bytes, entry.localOffset + 26);
    const extraLength = readUint16(bytes, entry.localOffset + 28);
    if (version > 20 || flags !== 0 || method !== 0 || extraLength !== 0 || checksum !== entry.checksum || compressedSize !== entry.size || uncompressedSize !== entry.size) {
      importError("ローカルファイルヘッダーの情報が一致しません。");
    }
    assertRange(bytes, entry.localOffset + 30, nameLength, "ローカルファイル名が不正です。");
    const localName = decodeEntryName(bytes.slice(entry.localOffset + 30, entry.localOffset + 30 + nameLength));
    if (localName !== entry.name) importError("ZIP内のファイル名が一致しません。");
    const dataOffset = entry.localOffset + 30 + nameLength;
    assertRange(bytes, dataOffset, entry.size, `${entry.name} のデータ範囲が不正です。`);
    const data = bytes.slice(dataOffset, dataOffset + entry.size);
    if (crc32(data) !== entry.checksum) importError(`${entry.name} のCRCが一致しません。`);
    result.set(entry.name, { name: entry.name, bytes: data });
    expectedOffset = dataOffset + entry.size;
  }
  if (expectedOffset !== centralOffset) importError("ZIP内のファイル領域が不正です。");
  return result;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) importError(`${label} に未対応の項目があります。`);
}
function assertString(value: unknown, label: string, max = 4_000): asserts value is string {
  if (typeof value !== "string" || value.length > max) importError(`${label} が不正です。`);
}
function assertNullableString(value: unknown, label: string, max = 4_000): asserts value is string | null {
  if (value !== null) assertString(value, label, max);
}
function assertFiniteNumber(value: unknown, label: string, min = -1_000_000_000, max = 1_000_000_000): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) importError(`${label} が不正です。`);
}
function assertIsoDate(value: unknown, label: string): void {
  assertString(value, label, 80);
  if (Number.isNaN(Date.parse(value))) importError(`${label} が日時として不正です。`);
}
function assertEnum<T extends string>(value: unknown, allowed: readonly T[] | Set<T>, label: string): asserts value is T {
  if (typeof value !== "string" || !(allowed instanceof Set ? allowed.has(value as T) : allowed.includes(value as T))) importError(`${label} が不正です。`);
}

const validateStrokes = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 10_000) importError("drawing.strokes が不正です。");
  let points = 0;
  value.forEach((stroke, index) => {
    if (!isObject(stroke)) importError(`strokes[${index}] が不正です。`);
    assertExactKeys(stroke, ["points", "startTime", "endTime"], `strokes[${index}]`);
    if (!Array.isArray(stroke.points) || stroke.points.length > 10_000) importError(`strokes[${index}].points が不正です。`);
    points += stroke.points.length;
    if (points > 200_000) importError("描画点が多すぎます。");
    stroke.points.forEach((point, pointIndex) => {
      if (!isObject(point)) importError(`points[${pointIndex}] が不正です。`);
      assertExactKeys(point, ["x", "y", "timestamp"], `points[${pointIndex}]`);
      assertFiniteNumber(point.x, "point.x", -100_000, 100_000);
      assertFiniteNumber(point.y, "point.y", -100_000, 100_000);
      assertFiniteNumber(point.timestamp, "point.timestamp", -MAX_TIMESTAMP_MS, MAX_TIMESTAMP_MS);
    });
    assertFiniteNumber(stroke.startTime, "stroke.startTime", -MAX_TIMESTAMP_MS, MAX_TIMESTAMP_MS);
    assertFiniteNumber(stroke.endTime, "stroke.endTime", -MAX_TIMESTAMP_MS, MAX_TIMESTAMP_MS);
  });
};

const validateManifest = (value: unknown): DebugBundleManifest => {
  if (!isObject(value)) importError("manifest.json がオブジェクトではありません。");
  assertExactKeys(value, ["format", "schemaVersion", "recordId", "createdAt", "outcome", "app", "generation", "drawing", "lyrics", "singingScore", "audio", "reporterNote"], "manifest.json");
  assertEnum(value.format, ["cho-ekaki-uta-debug-bundle"], "format");
  if (value.schemaVersion !== 1) {
    importError(typeof value.schemaVersion === "number" && value.schemaVersion > 1 ? "より新しいスキーマ版です。アプリを更新してください。" : "schemaVersion が不正です。");
  }
  assertString(value.recordId, "recordId", 200);
  assertIsoDate(value.createdAt, "createdAt");

  if (!isObject(value.outcome)) importError("outcome が不正です。");
  assertExactKeys(value.outcome, ["status", "failedStage", "error"], "outcome");
  assertEnum(value.outcome.status, ["success", "partial", "error"], "outcome.status");
  if (value.outcome.failedStage !== null) assertEnum(value.outcome.failedStage, TIMING_PHASES, "outcome.failedStage");
  assertNullableString(value.outcome.error, "outcome.error");

  if (!isObject(value.app)) importError("app が不正です。");
  assertExactKeys(value.app, ["buildId", "mode", "origin"], "app");
  assertString(value.app.buildId, "app.buildId", 256);
  assertEnum(value.app.mode, ["full", "deployment-preview"], "app.mode");
  assertString(value.app.origin, "app.origin", 1_024);

  if (!isObject(value.generation)) importError("generation が不正です。");
  assertExactKeys(value.generation, ["geminiModel", "startedAt", "completedAt", "durationsMs", "playbackKind", "voicevox", "voicevoxIssue"], "generation");
  assertNullableString(value.generation.geminiModel, "generation.geminiModel", 256);
  assertIsoDate(value.generation.startedAt, "generation.startedAt");
  assertIsoDate(value.generation.completedAt, "generation.completedAt");
  if (!isObject(value.generation.durationsMs)) importError("generation.durationsMs が不正です。");
  Object.entries(value.generation.durationsMs).forEach(([phase, duration]) => {
    if (!TIMING_PHASES.has(phase as GenerationTimingPhase)) importError("generation.durationsMs に未対応の段階があります。");
    assertFiniteNumber(duration, `generation.durationsMs.${phase}`, 0, 86_400_000);
  });
  assertEnum(value.generation.playbackKind, ["voice", "animation-only"], "generation.playbackKind");
  assertEnum(value.generation.voicevox, ["voice", "unavailable", "failed", "not-attempted"], "generation.voicevox");
  assertNullableString(value.generation.voicevoxIssue, "generation.voicevoxIssue");

  if (!isObject(value.drawing)) importError("drawing が不正です。");
  assertExactKeys(value.drawing, ["image", "strokes", "strokeGroups", "canvasSize", "lineWidth"], "drawing");
  if (!isObject(value.drawing.image)) importError("drawing.image が不正です。");
  assertExactKeys(value.drawing.image, ["path", "mimeType"], "drawing.image");
  if (value.drawing.image.path !== "input.png" || value.drawing.image.mimeType !== "image/png") importError("入力画像の情報が不正です。");
  validateStrokes(value.drawing.strokes);
  const drawingStrokes = value.drawing.strokes as unknown[];
  if (!Array.isArray(value.drawing.strokeGroups) || value.drawing.strokeGroups.length > 10_000) importError("drawing.strokeGroups が不正です。");
  const strokeGroupIds = new Set<string>();
  value.drawing.strokeGroups.forEach((group, index) => {
    if (!isObject(group)) importError(`strokeGroups[${index}] が不正です。`);
    assertExactKeys(group, ["id", "rawStrokeIndexes", "bounds", "startTime", "endTime", "length"], `strokeGroups[${index}]`);
    assertString(group.id, "strokeGroup.id", 200);
    if (strokeGroupIds.has(group.id)) importError("strokeGroup.id が重複しています。");
    strokeGroupIds.add(group.id);
    if (!Array.isArray(group.rawStrokeIndexes) || group.rawStrokeIndexes.length > 10_000) importError("rawStrokeIndexes が不正です。");
    group.rawStrokeIndexes.forEach((strokeIndex) => {
      if (!Number.isInteger(strokeIndex) || strokeIndex < 0 || strokeIndex >= drawingStrokes.length) importError("rawStrokeIndexes が不正です。");
    });
    if (!isObject(group.bounds)) importError("strokeGroup.bounds が不正です。");
    assertExactKeys(group.bounds, ["minX", "minY", "maxX", "maxY"], "strokeGroup.bounds");
    [group.bounds.minX, group.bounds.minY, group.bounds.maxX, group.bounds.maxY].forEach((number) => assertFiniteNumber(number, "strokeGroup.bounds", -100_000, 100_000));
    assertFiniteNumber(group.startTime, "strokeGroup.startTime", -MAX_TIMESTAMP_MS, MAX_TIMESTAMP_MS);
    assertFiniteNumber(group.endTime, "strokeGroup.endTime", -MAX_TIMESTAMP_MS, MAX_TIMESTAMP_MS);
    assertFiniteNumber(group.length, "strokeGroup.length", 0, 1_000_000_000);
  });
  if (value.drawing.canvasSize !== null) {
    if (!isObject(value.drawing.canvasSize)) importError("drawing.canvasSize が不正です。");
    assertExactKeys(value.drawing.canvasSize, ["width", "height"], "drawing.canvasSize");
    assertFiniteNumber(value.drawing.canvasSize.width, "canvasSize.width", 1, 10_000);
    assertFiniteNumber(value.drawing.canvasSize.height, "canvasSize.height", 1, 10_000);
  }
  if (value.drawing.lineWidth !== null) assertFiniteNumber(value.drawing.lineWidth, "drawing.lineWidth", 0.01, 10_000);

  if (value.lyrics !== null) {
    if (!isObject(value.lyrics)) importError("lyrics が不正です。");
    const lyricKeys = Object.keys(value.lyrics);
    if (lyricKeys.some((key) => !["title", "lines", "singingKanaLines", "identifiedObject", "lineStrokeMappings", "modelName"].includes(key))) importError("lyrics に未対応の項目があります。");
    assertString(value.lyrics.title, "lyrics.title", 500);
    assertString(value.lyrics.identifiedObject, "lyrics.identifiedObject", 500);
    if (!Array.isArray(value.lyrics.lines) || value.lyrics.lines.length > 100) importError("lyrics.lines が不正です。");
    const lyricLines = value.lyrics.lines as unknown[];
    value.lyrics.lines.forEach((line) => assertString(line, "lyrics.lines", 2_000));
    if (value.lyrics.singingKanaLines !== undefined) {
      if (!Array.isArray(value.lyrics.singingKanaLines) || value.lyrics.singingKanaLines.length !== value.lyrics.lines.length) importError("lyrics.singingKanaLines が不正です。");
      value.lyrics.singingKanaLines.forEach((line) => assertString(line, "lyrics.singingKanaLines", 2_000));
    }
    if (value.lyrics.modelName !== undefined) assertString(value.lyrics.modelName, "lyrics.modelName", 256);
    if (value.lyrics.lineStrokeMappings !== undefined) {
      if (!Array.isArray(value.lyrics.lineStrokeMappings) || value.lyrics.lineStrokeMappings.length > lyricLines.length) importError("lyrics.lineStrokeMappings が不正です。");
      value.lyrics.lineStrokeMappings.forEach((mapping, index) => {
        if (!isObject(mapping)) importError(`lineStrokeMappings[${index}] が不正です。`);
        assertExactKeys(mapping, ["lineIndex", "strokeGroupIds"], `lineStrokeMappings[${index}]`);
        if (typeof mapping.lineIndex !== "number" || !Number.isInteger(mapping.lineIndex) || mapping.lineIndex < 0 || mapping.lineIndex >= lyricLines.length || !Array.isArray(mapping.strokeGroupIds) || mapping.strokeGroupIds.length > 10_000) importError("lineStrokeMappings が不正です。");
        mapping.strokeGroupIds.forEach((id) => {
          assertString(id, "lineStrokeMappings.strokeGroupIds", 200);
          if (!strokeGroupIds.has(id)) importError("lineStrokeMappings が未知のストロークグループを参照しています。");
        });
      });
    }
  }

  if (value.singingScore !== null) {
    if (!isObject(value.singingScore)) importError("singingScore が不正です。");
    assertExactKeys(value.singingScore, ["notes"], "singingScore");
    if (!Array.isArray(value.singingScore.notes) || value.singingScore.notes.length > 3_000) importError("singingScore.notes が不正です。");
    value.singingScore.notes.forEach((note, index) => {
      if (!isObject(note)) importError(`notes[${index}] が不正です。`);
      assertExactKeys(note, ["lyric", "key", "frame_length"], `notes[${index}]`);
      assertString(note.lyric, "note.lyric", 500);
      if (note.key !== null && (typeof note.key !== "number" || !Number.isInteger(note.key) || note.key < 0 || note.key > 127)) importError("note.key が不正です。");
      assertFiniteNumber(note.frame_length, "note.frame_length", 0.01, 1_000_000);
    });
  }
  if (value.audio !== null) {
    if (!isObject(value.audio)) importError("audio が不正です。");
    assertExactKeys(value.audio, ["path", "mimeType"], "audio");
    if (value.audio.path !== "voice.wav" || value.audio.mimeType !== "audio/wav") importError("audio が不正です。");
  }
  assertNullableString(value.reporterNote, "reporterNote", 2_000);
  return value as unknown as DebugBundleManifest;
};

const assertPng = (bytes: Uint8Array) => {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    importError("input.png がPNG画像ではありません。");
  }
};

const assertWav = (bytes: Uint8Array) => {
  if (bytes.length < 12 || bytes.length > MAX_AUDIO_BYTES || bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46 || bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) {
    importError("voice.wav がWAV音声ではありません。");
  }
};

/** Parse a debug ZIP without fetching, executing, or rendering any embedded content. */
export const importDebugBundle = async (file: Blob): Promise<DebugBundleArtifacts> => {
  if (file.size < 22 || file.size > MAX_BUNDLE_BYTES) importError("ファイルサイズが対応範囲外です。");
  const entries = parseStoredZip(new Uint8Array(await file.arrayBuffer()));
  const manifestEntry = entries.get("manifest.json");
  const imageEntry = entries.get("input.png");
  const readmeEntry = entries.get("README.txt");
  if (!manifestEntry || !imageEntry || !readmeEntry) importError("必須ファイルが見つかりません。");
  try {
    textDecoder.decode(readmeEntry.bytes);
  } catch {
    importError("README.txt がUTF-8ではありません。");
  }
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(textDecoder.decode(manifestEntry.bytes));
  } catch {
    importError("manifest.json が有効なUTF-8 JSONではありません。");
  }
  const manifest = validateManifest(parsedManifest);
  assertPng(imageEntry.bytes);
  const voiceEntry = entries.get("voice.wav");
  if ((manifest.audio !== null) !== Boolean(voiceEntry)) importError("音声メタデータと voice.wav が一致しません。");
  if (voiceEntry) assertWav(voiceEntry.bytes);
  return sanitizeDebugBundleArtifacts({
    manifest,
    imageBlob: new Blob([imageEntry.bytes], { type: "image/png" }),
    voiceAudioBlob: voiceEntry ? new Blob([voiceEntry.bytes], { type: "audio/wav" }) : null,
  });
};
