import type {
  DrawingData,
  EvaluationSubmissionPayload,
  LyricsCandidate,
  SingingScore,
} from "../types";
/** Kept client-side so archive UI does not import a Worker module into Vite. */
export const CREATION_ARCHIVE_CONSENT_VERSION = "creation-archive-v1" as const;

export const CREATION_ARCHIVE_INIT_URL = "/api/creation-archives";
export const CREATION_ARCHIVE_ASSET_URL = (archiveId: string, assetName: CreationArchiveAssetName) =>
  `/api/creation-archives/${encodeURIComponent(archiveId)}/assets/${encodeURIComponent(assetName)}`;
export const CREATION_ARCHIVE_COMPLETE_URL = (archiveId: string) =>
  `/api/creation-archives/${encodeURIComponent(archiveId)}`;
export const CREATION_ARCHIVE_DELETE_URL = (archiveId: string) =>
  `/api/creation-archives/${encodeURIComponent(archiveId)}`;
export const CREATION_ARCHIVE_INDEX_KEY = "creation-archive-delete-capabilities-v1";

export const CREATION_ARCHIVE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const CREATION_ARCHIVE_JSON_MAX_BYTES = 4 * 1024 * 1024;
export const CREATION_ARCHIVE_WAV_MAX_BYTES = 32 * 1024 * 1024;
export const CREATION_ARCHIVE_TOTAL_MAX_BYTES = 72 * 1024 * 1024;

export type CreationArchiveAssetName =
  | "input-image"
  | "drawing-json"
  | "candidate-a-json"
  | "candidate-b-json"
  | "candidate-a-wav"
  | "candidate-b-wav"
  | "manifest";
export type CreationArchiveVoiceStatus = "voice" | "unavailable" | "failed" | "not-attempted";
export type CreationArchiveStatus = "pending" | "complete" | "partial" | "deleting" | "deleted" | "failed";

export interface CreationArchiveCandidateSnapshot {
  candidate: LyricsCandidate;
  score: SingingScore | null;
  /** Only a real VOICEVOX result is archived. Silent fallback audio is ignored. */
  voiceAudioBlob: Blob | null;
  voiceStatus: CreationArchiveVoiceStatus;
  voicevoxIssue: string | null;
  voicevoxServer?: string | null;
}

/** Immutable-at-start input. Callers must not mutate this object while archiving. */
export interface CreationArchiveSnapshot {
  drawingData: DrawingData;
  drawingAnalysis: EvaluationSubmissionPayload["drawingAnalysis"];
  candidates: readonly [CreationArchiveCandidateSnapshot, CreationArchiveCandidateSnapshot];
  displayOrder: EvaluationSubmissionPayload["displayOrder"];
  activeCandidateId: EvaluationSubmissionPayload["activeCandidateId"];
  buildId: string;
  mode: "full" | "deployment-preview";
  createdAt: string;
  modelInfo: EvaluationSubmissionPayload["modelInfo"];
  lyricsPromptVersion: string | null;
  generationError?: string | null;
}

export interface CreationArchiveAssetSpec {
  name: CreationArchiveAssetName;
  contentType: string;
  bytes: number;
  sha256: string;
}

export interface CreationArchiveIndexEntry {
  archiveId: string;
  generationId: string;
  createdAt: string;
  expiresAt: number;
  status: CreationArchiveStatus;
  deleteCapability: string;
}

export interface CreationArchiveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface CreationArchiveClientOptions {
  fetcher?: typeof fetch;
  storage?: CreationArchiveStorage | null;
  now?: () => number;
}

export interface CreationArchiveInitResponse {
  archiveId: string;
  uploadCapability: string;
  deleteCapability: string;
  pendingExpiresAt: number;
  expiresAt: number;
  assets: readonly { name: CreationArchiveAssetName; maxBytes: number; contentType: string }[];
}

export type CreationArchiveStartResult =
  | {
      status: "complete" | "partial";
      archiveId: string;
      generationId: string;
      uploadedAssets: readonly CreationArchiveAssetName[];
      failedAssets: readonly { name: CreationArchiveAssetName; message: string }[];
      deleteCapabilityPersisted: boolean;
      deletionReceipt: Blob | null;
      error: string | null;
    }
  | {
      status: "failed";
      archiveId: string | null;
      generationId: string;
      uploadedAssets: readonly [];
      failedAssets: readonly { name: CreationArchiveAssetName | "init"; message: string }[];
      deleteCapabilityPersisted: false;
      deletionReceipt: Blob | null;
      error: string;
    };

export interface StartCreationArchiveInput {
  evaluation: EvaluationSubmissionPayload;
  generationTicket: string;
  consentVersion: string;
  snapshot: CreationArchiveSnapshot;
  provenance?: "model-verified" | "client-uploaded";
}

export interface CreationArchiveDeleteResult {
  deleted: boolean;
  archiveId: string;
  error: string | null;
}
export interface CreationArchiveStatusResult {
  archiveId: string;
  status: CreationArchiveStatus | null;
  error: string | null;
}

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const ASSET_NAMES: readonly CreationArchiveAssetName[] = [
  "input-image", "drawing-json", "candidate-a-json", "candidate-b-json", "candidate-a-wav", "candidate-b-wav", "manifest",
];

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
};

const canonicalJson = (value: unknown) => JSON.stringify(canonicalize(value));
const digest = async (bytes: ArrayBuffer | Uint8Array) => {
  const hash = await crypto.subtle.digest("SHA-256", bytes instanceof Uint8Array ? bytes : bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const jsonBytes = (value: unknown, literal = false) => encoder.encode(literal ? JSON.stringify(value) : canonicalJson(value));

const browserStorage = (): CreationArchiveStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const readIndex = (storage: CreationArchiveStorage | null): CreationArchiveIndexEntry[] => {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(CREATION_ARCHIVE_INDEX_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is CreationArchiveIndexEntry =>
      !!entry && typeof entry === "object" && UUID.test(String(entry.archiveId)) && UUID.test(String(entry.generationId))
      && typeof entry.deleteCapability === "string" && entry.deleteCapability.length > 0
      && typeof entry.createdAt === "string" && Number.isSafeInteger(entry.expiresAt)
      && ["pending", "complete", "partial", "deleting", "deleted", "failed"].includes(String(entry.status)),
    );
  } catch {
    return [];
  }
};

const writeIndex = (storage: CreationArchiveStorage | null, entries: readonly CreationArchiveIndexEntry[]) => {
  if (!storage) return false;
  try {
    // Never discard a live deletion capability: the retention period is one
    // year, so a full index is a fail-closed condition for a new upload.
    if (entries.length > 50) return false;
    storage.setItem(CREATION_ARCHIVE_INDEX_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
};

export const listCreationArchiveEntries = (storage: CreationArchiveStorage | null = browserStorage()) => readIndex(storage);

export const createCreationArchiveDeletionReceipt = (entry: CreationArchiveIndexEntry) => new Blob([
  JSON.stringify({ schemaVersion: 1, archiveId: entry.archiveId, generationId: entry.generationId, expiresAt: entry.expiresAt, deleteCapability: entry.deleteCapability }),
], { type: "application/json" });

export const downloadCreationArchiveDeletionReceipt = (entry: CreationArchiveIndexEntry, download: (blob: Blob, fileName: string) => void = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}) => download(createCreationArchiveDeletionReceipt(entry), `creation-archive-${entry.archiveId}-deletion-receipt.json`);

export const downloadCreationArchiveDeletionReceiptBlob = (archiveId: string, receipt: Blob) => {
  const url = URL.createObjectURL(receipt);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `creation-archive-${archiveId}-deletion-receipt.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

export const importCreationArchiveDeletionReceipt = async (
  receipt: Blob,
  storage: CreationArchiveStorage | null = browserStorage(),
): Promise<{ entry: CreationArchiveIndexEntry | null; error: string | null }> => {
  try {
    if (receipt.size < 1 || receipt.size > 8 * 1024) throw new Error("削除レシートのサイズが正しくありません。");
    const value = JSON.parse(await receipt.text()) as Record<string, unknown>;
    if (value.schemaVersion !== 1 || !UUID.test(String(value.archiveId)) || !UUID.test(String(value.generationId))
      || !Number.isSafeInteger(value.expiresAt) || typeof value.deleteCapability !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value.deleteCapability)) {
      throw new Error("削除レシートの形式が正しくありません。");
    }
    const entry: CreationArchiveIndexEntry = { archiveId: String(value.archiveId), generationId: String(value.generationId), createdAt: new Date().toISOString(), expiresAt: Number(value.expiresAt), status: "pending", deleteCapability: value.deleteCapability };
    if (!writeIndex(storage, [...readIndex(storage).filter((item) => item.archiveId !== entry.archiveId), entry])) throw new Error("このブラウザに削除レシートを保存できませんでした。");
    return { entry, error: null };
  } catch (error) {
    return { entry: null, error: errorMessage(error) };
  }
};

const parseImage = async (imageUri: string, fetcher: typeof fetch) => {
  const response = await fetcher(imageUri);
  if (!response.ok) throw new Error("入力画像を読み込めませんでした。");
  const raw = await response.blob();
  const contentType = raw.type.toLowerCase() || (/^data:image\/webp/i.test(imageUri) ? "image/webp" : "image/png");
  if (contentType !== "image/png" && contentType !== "image/webp") throw new Error("入力画像はPNGまたはWebPで保存します。");
  if (raw.size < 1 || raw.size > CREATION_ARCHIVE_IMAGE_MAX_BYTES) throw new Error("入力画像が大きすぎます。");
  return new Blob([await raw.arrayBuffer()], { type: contentType });
};

const timedFetch = (fetcher: typeof fetch, url: RequestInfo | URL, init: RequestInit, timeoutMs: number) =>
  fetcher(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });

const makeJsonAsset = async (name: CreationArchiveAssetName, value: unknown, literal = false): Promise<{ spec: CreationArchiveAssetSpec; body: Uint8Array }> => {
  const body = jsonBytes(value, literal);
  if (body.byteLength < 1 || body.byteLength > CREATION_ARCHIVE_JSON_MAX_BYTES) throw new Error(`${name}が大きすぎます。`);
  return { spec: { name, contentType: "application/json", bytes: body.byteLength, sha256: await digest(body) }, body };
};

const makeBlobAsset = async (name: CreationArchiveAssetName, body: Blob, contentType: string, max: number) => {
  if (body.size < 1 || body.size > max) throw new Error(`${name}が大きすぎます。`);
  const bytes = new Uint8Array(await body.arrayBuffer());
  return { spec: { name, contentType, bytes: bytes.byteLength, sha256: await digest(bytes) }, body: bytes };
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "作品を保存できませんでした。";
const readError = async (response: Response) => {
  const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
  return body.error ?? body.message ?? `作品を保存できませんでした（${response.status}）。`;
};

const validateInitResponse = (value: unknown): CreationArchiveInitResponse => {
  if (!value || typeof value !== "object") throw new Error("保存APIの応答が正しくありません。");
  const row = value as Record<string, unknown>;
  if (!UUID.test(String(row.archiveId)) || typeof row.uploadCapability !== "string" || typeof row.deleteCapability !== "string"
    || !Number.isSafeInteger(row.pendingExpiresAt) || !Number.isSafeInteger(row.expiresAt) || !Array.isArray(row.assets)) throw new Error("保存APIの応答が正しくありません。");
  const assets = row.assets.filter((asset): asset is { name: CreationArchiveAssetName; maxBytes: number; contentType: string } =>
    !!asset && typeof asset === "object" && ASSET_NAMES.includes((asset as { name?: CreationArchiveAssetName }).name as CreationArchiveAssetName)
    && Number.isSafeInteger((asset as { maxBytes?: number }).maxBytes) && typeof (asset as { contentType?: string }).contentType === "string",
  );
  if (assets.length !== row.assets.length) throw new Error("保存APIのアセット一覧が正しくありません。");
  return { archiveId: String(row.archiveId), uploadCapability: row.uploadCapability, deleteCapability: row.deleteCapability, pendingExpiresAt: Number(row.pendingExpiresAt), expiresAt: Number(row.expiresAt), assets };
};

const snapshotAssets = async (input: StartCreationArchiveInput, fetcher: typeof fetch) => {
  if (input.consentVersion !== CREATION_ARCHIVE_CONSENT_VERSION) throw new Error("新しい作品保存の同意が必要です。");
  const candidates = [...input.snapshot.candidates].sort((a, b) => a.candidate.candidateId.localeCompare(b.candidate.candidateId));
  if (candidates.length !== 2 || candidates[0].candidate.candidateId !== "candidate-a" || candidates[1].candidate.candidateId !== "candidate-b") throw new Error("A/B候補がそろっていません。");
  const image = await parseImage(input.snapshot.drawingData.imageUri, fetcher);
  // Ticket verification signs this exact, insertion-order-preserving JSON.
  const drawing = { strokes: input.snapshot.drawingData.strokes, strokeGroups: input.snapshot.drawingData.strokeGroups ?? [] };
  const drawingAsset = await makeJsonAsset("drawing-json", drawing, true);
  // Candidate files are the signed model outputs. Playback details stay in the
  // manifest so a later UI change cannot alter the signed candidate payload.
  const candidateAssets = await Promise.all(candidates.map((item) => makeJsonAsset(`${item.candidate.candidateId}-json`, item.candidate, true)));
  const imageAsset = await makeBlobAsset("input-image", image, image.type, CREATION_ARCHIVE_IMAGE_MAX_BYTES);
  const assets = [imageAsset, drawingAsset, ...candidateAssets];
  const specs = assets.map(({ spec }) => spec);
  const wavAssets: { spec: CreationArchiveAssetSpec; body: Uint8Array }[] = [];
  for (const item of candidates) {
    if (item.voiceStatus !== "voice" || !item.voiceAudioBlob) continue;
    wavAssets.push(await makeBlobAsset(`${item.candidate.candidateId}-wav`, item.voiceAudioBlob, "audio/wav", CREATION_ARCHIVE_WAV_MAX_BYTES));
  }
  specs.push(...wavAssets.map(({ spec }) => spec));
  const manifestValue = {
    schemaVersion: 1,
    generationId: input.evaluation.generationId,
    consentVersion: input.consentVersion,
    createdAt: input.snapshot.createdAt,
    buildId: input.snapshot.buildId,
    mode: input.snapshot.mode,
    drawingAnalysis: input.snapshot.drawingAnalysis,
    modelInfo: input.snapshot.modelInfo,
    lyricsPromptVersion: input.snapshot.lyricsPromptVersion,
    displayOrder: input.evaluation.displayOrder,
    activeCandidateId: input.evaluation.activeCandidateId,
    drawingCanvas: { canvasSize: input.snapshot.drawingData.canvasSize ?? null, lineWidth: input.snapshot.drawingData.lineWidth ?? null },
    candidates: candidates.map((item) => ({ candidateId: item.candidate.candidateId, score: item.score, voiceStatus: item.voiceStatus, voicevoxServer: item.voicevoxServer ?? null })),
    assets: specs,
  };
  const manifestAsset = await makeJsonAsset("manifest", manifestValue);
  const all = [...assets, ...wavAssets, manifestAsset];
  const totalBytes = all.reduce((total, asset) => total + asset.spec.bytes, 0);
  if (totalBytes > CREATION_ARCHIVE_TOTAL_MAX_BYTES) throw new Error("作品データ全体が大きすぎます。");
  return { assets: all, specs: all.map(({ spec }) => spec), manifestSha256: manifestAsset.spec.sha256 };
};

export const startCreationArchive = async (
  input: StartCreationArchiveInput,
  options: CreationArchiveClientOptions = {},
): Promise<CreationArchiveStartResult> => {
  const fetcher = options.fetcher ?? fetch;
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const generationId = input.evaluation.generationId;
  try {
    if (input.evaluation.centralConsent !== "accepted") throw new Error("評価保存の同意だけでは作品保存を開始できません。");
    const built = await snapshotAssets(input, fetcher);
    const initResponse = await timedFetch(fetcher, CREATION_ARCHIVE_INIT_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationId, evaluation: input.evaluation, consentVersion: input.consentVersion, generationTicket: input.generationTicket, provenance: input.provenance ?? "model-verified", assets: built.specs }),
    }, 60_000);
    if (!initResponse.ok) throw new Error(await readError(initResponse));
    const initialized = validateInitResponse(await initResponse.json());
    const entry: CreationArchiveIndexEntry = { archiveId: initialized.archiveId, generationId, createdAt: new Date((options.now ?? Date.now)()).toISOString(), expiresAt: initialized.expiresAt, status: "pending", deleteCapability: initialized.deleteCapability };
    const persisted = writeIndex(storage, [...readIndex(storage).filter((item) => item.archiveId !== entry.archiveId), entry]);
    const receipt = persisted ? null : createCreationArchiveDeletionReceipt(entry);
    if (!persisted) return { status: "failed", archiveId: initialized.archiveId, generationId, uploadedAssets: [], failedAssets: [{ name: "init", message: "削除用の保存先を利用できないため、アップロードを止めました。" }], deleteCapabilityPersisted: false, deletionReceipt: receipt, error: "削除用の保存先を用意できません。削除レシートを保存してから再試行してください。" };

    const declared = new Map(initialized.assets.map((asset) => [asset.name, asset]));
    const uploadedAssets: CreationArchiveAssetName[] = [];
    const failedAssets: { name: CreationArchiveAssetName; message: string }[] = [];
    for (const asset of built.assets) {
      const declaration = declared.get(asset.spec.name);
      if (!declaration || declaration.maxBytes !== asset.spec.bytes || declaration.contentType.toLowerCase() !== asset.spec.contentType) {
        failedAssets.push({ name: asset.spec.name, message: "保存APIの予約内容と一致しません。" });
        continue;
      }
      try {
        const response = await timedFetch(fetcher, CREATION_ARCHIVE_ASSET_URL(initialized.archiveId, asset.spec.name), {
          method: "PUT", headers: { "Content-Type": asset.spec.contentType, "Authorization": `Bearer ${initialized.uploadCapability}`, "X-Content-SHA256": asset.spec.sha256 }, body: asset.body,
        }, 120_000);
        if (!response.ok) throw new Error(await readError(response));
        uploadedAssets.push(asset.spec.name);
      } catch (error) {
        failedAssets.push({ name: asset.spec.name, message: errorMessage(error) });
      }
    }
    if (failedAssets.length === 0) {
      const completeResponse = await timedFetch(fetcher, CREATION_ARCHIVE_COMPLETE_URL(initialized.archiveId), {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${initialized.uploadCapability}` }, body: JSON.stringify({ manifestSha256: built.manifestSha256 }),
      }, 60_000);
      if (!completeResponse.ok) failedAssets.push({ name: "manifest", message: await readError(completeResponse) });
    }
    const complete = failedAssets.length === 0;
    const nextEntry = { ...entry, status: complete ? "complete" as const : "partial" as const };
    writeIndex(storage, [...readIndex(storage).filter((item) => item.archiveId !== entry.archiveId), nextEntry]);
    return { status: complete ? "complete" : "partial", archiveId: initialized.archiveId, generationId, uploadedAssets, failedAssets, deleteCapabilityPersisted: true, deletionReceipt: null, error: complete ? null : "作品の一部を保存できませんでした。削除または期限切れまで保留されます。" };
  } catch (error) {
    return { status: "failed", archiveId: null, generationId, uploadedAssets: [], failedAssets: [{ name: "init", message: errorMessage(error) }], deleteCapabilityPersisted: false, deletionReceipt: null, error: errorMessage(error) };
  }
};

export const deleteCreationArchiveFromClient = async (
  archiveId: string,
  options: CreationArchiveClientOptions = {},
): Promise<CreationArchiveDeleteResult> => {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const entry = readIndex(storage).find((item) => item.archiveId === archiveId);
  if (!entry) return { deleted: false, archiveId, error: "このブラウザには削除用レシートがありません。" };
  try {
    const response = await timedFetch(options.fetcher ?? fetch, CREATION_ARCHIVE_DELETE_URL(archiveId), {
      method: "DELETE", headers: { "Authorization": `Bearer ${entry.deleteCapability}` },
    }, 60_000);
    if (!response.ok) throw new Error(await readError(response));
    const result = await response.json().catch(() => ({})) as { deleted?: unknown };
    if (result.deleted !== true) return { deleted: false, archiveId, error: "削除はまだ完了していません。もう一度確認してください。" };
    writeIndex(storage, readIndex(storage).filter((item) => item.archiveId !== archiveId));
    return { deleted: true, archiveId, error: null };
  } catch (error) {
    return { deleted: false, archiveId, error: errorMessage(error) };
  }
};

export const getCreationArchiveStatusFromClient = async (
  archiveId: string,
  options: CreationArchiveClientOptions = {},
): Promise<CreationArchiveStatusResult> => {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const entry = readIndex(storage).find((item) => item.archiveId === archiveId);
  if (!entry) return { archiveId, status: null, error: "このブラウザには削除用レシートがありません。" };
  try {
    const response = await timedFetch(options.fetcher ?? fetch, CREATION_ARCHIVE_DELETE_URL(archiveId), {
      headers: { "Authorization": `Bearer ${entry.deleteCapability}` },
    }, 60_000);
    if (!response.ok) throw new Error(await readError(response));
    const result = await response.json() as { status?: CreationArchiveStatus };
    const status = result.status;
    if (!status || !["pending", "complete", "partial", "deleting", "deleted", "failed"].includes(status)) throw new Error("保存状況の応答が正しくありません。");
    writeIndex(storage, readIndex(storage).map((item) => item.archiveId === archiveId ? { ...item, status } : item));
    return { archiveId, status, error: null };
  } catch (error) {
    return { archiveId, status: null, error: errorMessage(error) };
  }
};

export const getCreationArchiveDeletionReceipt = (archiveId: string, storage: CreationArchiveStorage | null = browserStorage()) => {
  const entry = readIndex(storage).find((item) => item.archiveId === archiveId);
  return entry ? createCreationArchiveDeletionReceipt(entry) : null;
};
