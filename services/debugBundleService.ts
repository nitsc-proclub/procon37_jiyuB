import { DebugBundleManifest, DrawingData, GenerationTimingDurations, GenerationTimingPhase, LyricsResponse, SingingScore } from "../types";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 80 * 1024 * 1024;
const MAX_ERROR_LENGTH = 4_000;
const MAX_REPORTER_NOTE_LENGTH = 2_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WAV_HEADER_LENGTH = 12;

export type DebugBundleVoicevoxStatus = "voice" | "unavailable" | "failed" | "not-attempted";

export interface DebugBundleSource {
  recordId: string;
  drawingData: DrawingData;
  lyrics: LyricsResponse | null;
  singingScore: SingingScore | null;
  voiceAudioBlob: Blob | null;
  playbackKind: "voice" | "animation-only";
  voicevoxStatus: DebugBundleVoicevoxStatus;
  voicevoxIssue: string | null;
  startedAt: string;
  completedAt: string;
  failedStage: GenerationTimingPhase | null;
  error: string | null;
  durationsMs: GenerationTimingDurations;
}

export interface CreateDebugBundleOptions {
  source: DebugBundleSource;
  reporterNote: string;
  buildId: string;
  mode: "full" | "deployment-preview";
  origin: string;
}

export interface CreatedDebugBundle {
  blob: Blob;
  fileName: string;
  manifest: DebugBundleManifest;
}

/** Sanitized, reusable bundle data. Safe to persist in browser-only history. */
export interface DebugBundleArtifacts {
  manifest: DebugBundleManifest;
  imageBlob: Blob;
  voiceAudioBlob: Blob | null;
}

const textEncoder = new TextEncoder();

const safeOrigin = (value: string) => {
  try {
    return new URL(value).origin;
  } catch {
    return "unknown";
  }
};

const redactSensitiveText = (value: string | null, maxLength = MAX_ERROR_LENGTH) => {
  if (!value) return null;

  const redacted = value
    .replace(/AIza[\w-]{20,}/g, "[REDACTED_GEMINI_API_KEY]")
    .replace(/\bBearer\s+[\w.~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:key|api[_-]?key|token|authorization|password|secret)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s]+:[^\s@/]+@/gi, "https://[REDACTED]@")
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?/gi, "[REDACTED_VOICEVOX_URL]")
    .replace(/data:[^\s,]+,[^\s]+/gi, "[REDACTED_DATA_URI]");

  return redacted.slice(0, maxLength);
};

const normalizeReporterNote = (value: string) => redactSensitiveText(value.trim(), MAX_REPORTER_NOTE_LENGTH);

export const createDebugRecordId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `debug-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const validatePngBlob = async (image: Blob) => {
  if (image.size === 0 || image.size > MAX_IMAGE_BYTES) {
    throw new Error("入力画像のサイズが大きすぎます。");
  }

  const bytes = new Uint8Array(await image.slice(0, PNG_SIGNATURE.length).arrayBuffer());
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new Error("入力画像が正しいPNG形式ではありません。");
  }
};

const dataUriToPngBlob = async (value: string) => {
  const matched = /^data:image\/png;base64,([a-z0-9+/=\s]+)$/i.exec(value);
  if (!matched) {
    throw new Error("入力画像がPNGデータではありません。");
  }

  const base64 = matched[1].replace(/\s/g, "");
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error("入力画像の読み取りに失敗しました。");
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const image = new Blob([bytes], { type: "image/png" });
  await validatePngBlob(image);
  return image;
};

const validateVoiceWav = async (audio: Blob) => {
  if (audio.size === 0 || audio.size > MAX_AUDIO_BYTES) {
    throw new Error("歌声音声のサイズが大きすぎます。");
  }

  const header = new Uint8Array(await audio.slice(0, WAV_HEADER_LENGTH).arrayBuffer());
  const isWav =
    header.length === WAV_HEADER_LENGTH &&
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x41 &&
    header[10] === 0x56 &&
    header[11] === 0x45;

  if (!isWav) {
    throw new Error("VOICEVOXの歌声音声がWAV形式ではありません。");
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

const writeUint16 = (target: Uint8Array, offset: number, value: number) => {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
};

const writeUint32 = (target: Uint8Array, offset: number, value: number) => {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
};

const toDosDateTime = (date: Date) => {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
};

type ZipEntry = { name: "manifest.json" | "input.png" | "voice.wav" | "README.txt"; bytes: Uint8Array };

const createStoredZip = (entries: ZipEntry[], now: Date) => {
  const { date, time } = toDosDateTime(now);
  const fileRecords: Uint8Array[] = [];
  const centralRecords: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name);
    const checksum = crc32(entry.bytes);
    const local = new Uint8Array(30 + nameBytes.length + entry.bytes.length);
    writeUint32(local, 0, 0x04034b50);
    writeUint16(local, 4, 20);
    writeUint16(local, 6, 0);
    writeUint16(local, 8, 0);
    writeUint16(local, 10, time);
    writeUint16(local, 12, date);
    writeUint32(local, 14, checksum);
    writeUint32(local, 18, entry.bytes.length);
    writeUint32(local, 22, entry.bytes.length);
    writeUint16(local, 26, nameBytes.length);
    writeUint16(local, 28, 0);
    local.set(nameBytes, 30);
    local.set(entry.bytes, 30 + nameBytes.length);
    fileRecords.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    writeUint32(central, 0, 0x02014b50);
    writeUint16(central, 4, 20);
    writeUint16(central, 6, 20);
    writeUint16(central, 8, 0);
    writeUint16(central, 10, 0);
    writeUint16(central, 12, time);
    writeUint16(central, 14, date);
    writeUint32(central, 16, checksum);
    writeUint32(central, 20, entry.bytes.length);
    writeUint32(central, 24, entry.bytes.length);
    writeUint16(central, 28, nameBytes.length);
    writeUint16(central, 30, 0);
    writeUint16(central, 32, 0);
    writeUint16(central, 34, 0);
    writeUint16(central, 36, 0);
    writeUint32(central, 38, 0);
    writeUint32(central, 42, offset);
    central.set(nameBytes, 46);
    centralRecords.push(central);
    offset += local.length;
  }

  const centralSize = centralRecords.reduce((total, record) => total + record.length, 0);
  const footer = new Uint8Array(22);
  writeUint32(footer, 0, 0x06054b50);
  writeUint16(footer, 4, 0);
  writeUint16(footer, 6, 0);
  writeUint16(footer, 8, entries.length);
  writeUint16(footer, 10, entries.length);
  writeUint32(footer, 12, centralSize);
  writeUint32(footer, 16, offset);
  writeUint16(footer, 20, 0);

  return new Blob([...fileRecords, ...centralRecords, footer], { type: "application/zip" });
};

const buildReadme = (hasVoice: boolean) => `絵描き歌メーカー デバッグ共有ファイル\n\nこのZIPには、再現・調査に必要な描画、ストローク、歌詞、楽譜${hasVoice ? "、VOICEVOXで生成した歌声" : ""}を含みます。\n\nファイル\n- manifest.json: 生成結果、エラー、描画ストローク、歌詞、楽譜、任意メモ\n- input.png: 入力画像\n${hasVoice ? "- voice.wav: VOICEVOXで実際に生成した歌声\n" : ""}\n含めない情報\n- Gemini APIキー、Cloudflare Accessの認証情報、メールアドレス\n- 年齢などの参加者情報\n- VOICEVOX接続URL\n- 音声なしアニメーション再生用の無音WAV\n\n共有前に、意図しない個人情報が描画やメモに含まれていないか確認してください。\n`;

const makeFileName = (createdAt: Date, recordId: string) => {
  const timestamp = createdAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `cho-ekaki-uta-debug-${timestamp}-${recordId.slice(0, 8)}.zip`;
};

export const buildDebugBundleArtifacts = async ({ source, buildId, mode, origin }: Omit<CreateDebugBundleOptions, "reporterNote">): Promise<DebugBundleArtifacts> => {
  const imageBlob = await dataUriToPngBlob(source.drawingData.imageUri);
  const includeVoice = source.playbackKind === "voice" && source.voiceAudioBlob !== null;
  if (includeVoice) {
    await validateVoiceWav(source.voiceAudioBlob);
  }

  const error = redactSensitiveText(source.error);
  const voicevoxIssue = redactSensitiveText(source.voicevoxIssue);
  const outcomeStatus = error ? "error" : source.voicevoxStatus === "failed" ? "partial" : "success";
  const manifest: DebugBundleManifest = {
    format: "cho-ekaki-uta-debug-bundle",
    schemaVersion: 1,
    recordId: source.recordId,
    createdAt: source.completedAt,
    outcome: {
      status: outcomeStatus,
      failedStage: source.failedStage,
      error,
    },
    app: {
      buildId: buildId || "unknown",
      mode,
      origin: safeOrigin(origin),
    },
    generation: {
      geminiModel: source.lyrics?.modelName ?? null,
      startedAt: source.startedAt,
      completedAt: source.completedAt,
      durationsMs: source.durationsMs,
      playbackKind: source.playbackKind,
      voicevox: source.voicevoxStatus,
      voicevoxIssue,
    },
    drawing: {
      image: { path: "input.png", mimeType: "image/png" },
      strokes: source.drawingData.strokes,
      strokeGroups: source.drawingData.strokeGroups ?? [],
      canvasSize: source.drawingData.canvasSize ?? null,
      lineWidth: source.drawingData.lineWidth ?? null,
    },
    lyrics: source.lyrics,
    singingScore: source.singingScore,
    audio: includeVoice ? { path: "voice.wav", mimeType: "audio/wav" } : null,
    reporterNote: null,
  };

  return {
    manifest,
    imageBlob,
    voiceAudioBlob: includeVoice ? source.voiceAudioBlob : null,
  };
};

export const createDebugBundleFromArtifacts = async ({
  artifacts,
  reporterNote,
}: {
  artifacts: DebugBundleArtifacts;
  reporterNote: string;
}): Promise<CreatedDebugBundle> => {
  const createdAtDate = Number.isNaN(Date.parse(artifacts.manifest.createdAt))
    ? new Date()
    : new Date(artifacts.manifest.createdAt);
  const includeVoice = artifacts.manifest.audio !== null && artifacts.voiceAudioBlob !== null;
  await validatePngBlob(artifacts.imageBlob);
  if (includeVoice) {
    await validateVoiceWav(artifacts.voiceAudioBlob);
  }

  const manifest: DebugBundleManifest = {
    ...artifacts.manifest,
    audio: includeVoice ? artifacts.manifest.audio : null,
    reporterNote: normalizeReporterNote(reporterNote),
  };

  const manifestBytes = textEncoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const imageBytes = new Uint8Array(await artifacts.imageBlob.arrayBuffer());
  const entries: ZipEntry[] = [
    { name: "manifest.json", bytes: manifestBytes },
    { name: "input.png", bytes: imageBytes },
  ];

  if (includeVoice) {
    entries.push({ name: "voice.wav", bytes: new Uint8Array(await artifacts.voiceAudioBlob.arrayBuffer()) });
  }
  entries.push({ name: "README.txt", bytes: textEncoder.encode(buildReadme(includeVoice)) });

  const rawSize = entries.reduce((total, entry) => total + entry.bytes.length, 0);
  if (rawSize > MAX_BUNDLE_BYTES) {
    throw new Error("デバッグZIPの合計サイズが大きすぎます。歌声を含めずにもう一度お試しください。");
  }

  return {
    blob: createStoredZip(entries, createdAtDate),
    fileName: makeFileName(createdAtDate, manifest.recordId),
    manifest,
  };
};

export const createDebugBundle = async ({ source, reporterNote, buildId, mode, origin }: CreateDebugBundleOptions): Promise<CreatedDebugBundle> => {
  const artifacts = await buildDebugBundleArtifacts({ source, buildId, mode, origin });
  return createDebugBundleFromArtifacts({ artifacts, reporterNote });
};

export const downloadDebugBundle = (bundle: CreatedDebugBundle) => {
  const objectUrl = URL.createObjectURL(bundle.blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = bundle.fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
};
