import { openBrowserHistoryDatabase as openDatabase, requestResult, transactionDone, RECORDS_STORE, ASSETS_STORE, IMAGES_STORE, GENERATIONS_STORE, EVALUATION_DRAFTS_STORE, BROWSER_HISTORY_MAX_BYTES, evaluationDraftByteSize, type StoredEvaluationDraft } from "./browserHistoryStorage";
import { DebugBundleArtifacts } from "./debugBundleService";
import { DebugBundleManifest, EvaluationDraft, UsageStats } from "../types";
import { notifyBrowserRecordsChanged } from "./browserRecordEvents";

export const DEBUG_HISTORY_MAX_RECORDS = 50;
export const DEBUG_HISTORY_MAX_BYTES = BROWSER_HISTORY_MAX_BYTES;

const japanDate = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
type BrowserGeneration = { recordId: string; date: string; recorded: boolean };

type StoredDebugHistoryRecord = {
  recordId: string;
  createdAt: string;
  manifest: DebugBundleManifest;
  byteSize: number;
  isFavorite?: boolean;
};

type StoredDebugHistoryAssets = {
  recordId: string;
  voiceAudioBlob: Blob | null;
};

type StoredDebugHistoryImage = { recordId: string; imageBlob: Blob; hasVoice: boolean };

export type DebugHistoryRecordSummary = StoredDebugHistoryRecord & {
  title: string;
  identifiedObject: string;
  hasVoice: boolean;
};

export type DebugHistoryRecord = DebugHistoryRecordSummary & {
  artifacts: DebugBundleArtifacts;
};

export type DebugHistoryStats = {
  count: number;
  storedBytes: number;
  originUsageBytes: number | null;
  originQuotaBytes: number | null;
};

export type DebugHistoryErrorCode = "unsupported" | "record-limit" | "size-limit" | "origin-quota" | "quota" | "corrupt";

export class DebugHistoryError extends Error {
  constructor(public readonly code: DebugHistoryErrorCode, message: string) {
    super(message);
    this.name = "DebugHistoryError";
  }
}

const textEncoder = new TextEncoder();

const getSummary = (record: StoredDebugHistoryRecord): DebugHistoryRecordSummary => ({
  ...record,
  title: record.manifest.lyrics?.title ?? "歌詞を作る前に終了",
  identifiedObject: record.manifest.lyrics?.identifiedObject ?? "未判定",
  hasVoice: record.manifest.audio !== null,
  isFavorite: record.isFavorite === true,
});

const getArtifactByteSize = (artifacts: DebugBundleArtifacts) =>
  textEncoder.encode(JSON.stringify(artifacts.manifest)).byteLength + artifacts.imageBlob.size + (artifacts.voiceAudioBlob?.size ?? 0);

/**
 * Creates the same read model used by IndexedDB without writing anything.
 * ZIP imports use this to offer a fully offline preview before the user
 * explicitly decides to retain it in this browser.
 */
export const createDebugHistoryRecord = (artifacts: DebugBundleArtifacts): DebugHistoryRecord => {
  const storedRecord: StoredDebugHistoryRecord = {
    recordId: artifacts.manifest.recordId,
    createdAt: artifacts.manifest.createdAt,
    manifest: artifacts.manifest,
    byteSize: getArtifactByteSize(artifacts),
  };

  return {
    ...getSummary(storedRecord),
    artifacts,
  };
};

const getStorageEstimate = async () => {
  if (typeof navigator === "undefined" || typeof navigator.storage?.estimate !== "function") {
    return { usage: null, quota: null };
  }

  try {
    const estimate = await navigator.storage.estimate();
    return {
      usage: typeof estimate.usage === "number" ? estimate.usage : null,
      quota: typeof estimate.quota === "number" ? estimate.quota : null,
    };
  } catch {
    return { usage: null, quota: null };
  }
};

const asDebugHistoryError = (error: unknown) => {
  if (error instanceof DebugHistoryError) return error;
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return new DebugHistoryError("quota", "Browser storage quota was exceeded.");
  }
  return error;
};

export const isDebugHistoryError = (value: unknown, code?: DebugHistoryErrorCode): value is DebugHistoryError =>
  value instanceof DebugHistoryError && (code === undefined || value.code === code);

/**
 * Callers must pass artifacts created by buildDebugBundleArtifacts. The
 * manifest/audio pair is checked again here before either Blob is persisted.
 */
export const saveDebugHistoryRecord = async (
  artifacts: DebugBundleArtifacts,
  { evaluationDraft = null, onlyIfExisting = false }: { evaluationDraft?: EvaluationDraft | null; onlyIfExisting?: boolean } = {},
): Promise<DebugHistoryRecordSummary | null> => {
  if ((artifacts.manifest.audio !== null) !== (artifacts.voiceAudioBlob !== null)) {
    throw new DebugHistoryError("corrupt", "Voice metadata and audio do not match.");
  }

  const byteSize = getArtifactByteSize(artifacts);
  const requestedByteSize = byteSize + (evaluationDraft ? evaluationDraftByteSize(evaluationDraft) : 0);
  if (requestedByteSize > DEBUG_HISTORY_MAX_BYTES) {
    throw new DebugHistoryError("size-limit", "This record is larger than the debug history limit.");
  }

  const estimate = await getStorageEstimate();
  if (estimate.usage !== null && estimate.quota !== null && estimate.quota - estimate.usage < requestedByteSize) {
    throw new DebugHistoryError("origin-quota", "This browser does not have enough free storage.");
  }

  try {
    const database = await openDatabase();
    const transaction = database.transaction([RECORDS_STORE, ASSETS_STORE, IMAGES_STORE, GENERATIONS_STORE, EVALUATION_DRAFTS_STORE], "readwrite");
    const recordsStore = transaction.objectStore(RECORDS_STORE);
    const records = await requestResult(recordsStore.getAll() as IDBRequest<StoredDebugHistoryRecord[]>);
    const generations = transaction.objectStore(GENERATIONS_STORE);
    const generation = await requestResult(generations.get(artifacts.manifest.recordId) as IDBRequest<BrowserGeneration | undefined>);
    const replacing = records.find((record) => record.recordId === artifacts.manifest.recordId);
    // A voice request finishing after deletion must never recreate the record.
    if (onlyIfExisting && !replacing) {
      await transactionDone(transaction);
      return null;
    }
    const draftsStore = transaction.objectStore(EVALUATION_DRAFTS_STORE);
    const drafts = await requestResult(draftsStore.getAll() as IDBRequest<StoredEvaluationDraft[]>);
    const existingDraft = evaluationDraft ? drafts.find(entry => entry.generationId === evaluationDraft.generationId) : undefined;
    // Async audio completion carries a consent-time snapshot, which may be
    // older than ratings/preferences already saved by the participant.
    const draftToSave = existingDraft && (onlyIfExisting || existingDraft.draft.updatedAt >= (evaluationDraft?.updatedAt ?? ""))
      ? existingDraft.draft : evaluationDraft;
    const draftBytes = drafts.reduce((total, entry) => total + entry.byteSize, 0)
      - (existingDraft?.byteSize ?? 0) + (draftToSave ? evaluationDraftByteSize(draftToSave) : 0);
    const remainingRecords = replacing ? records.filter((record) => record.recordId !== replacing.recordId) : records;
    const storedBytes = remainingRecords.reduce((total, record) => total + record.byteSize, 0);

    if (!replacing && records.length >= DEBUG_HISTORY_MAX_RECORDS) {
      transaction.abort();
      throw new DebugHistoryError("record-limit", "The debug history already contains 50 records.");
    }
    if (storedBytes + byteSize + draftBytes > DEBUG_HISTORY_MAX_BYTES) {
      transaction.abort();
      throw new DebugHistoryError("size-limit", "The debug history would exceed 100 MB.");
    }

    const storedRecord: StoredDebugHistoryRecord = {
      recordId: artifacts.manifest.recordId,
      createdAt: artifacts.manifest.createdAt,
      manifest: artifacts.manifest,
      byteSize,
      isFavorite: replacing?.isFavorite === true,
    };
    try {
      recordsStore.put(storedRecord);
      if (draftToSave) draftsStore.put({ generationId: draftToSave.generationId, draft: draftToSave,
        recordIds: [...new Set([...(existingDraft?.recordIds ?? []), storedRecord.recordId])],
        byteSize: evaluationDraftByteSize(draftToSave) } satisfies StoredEvaluationDraft);
      if (generation) generations.put({ ...generation, recorded: true });
      transaction.objectStore(ASSETS_STORE).put({
        recordId: artifacts.manifest.recordId,
        voiceAudioBlob: artifacts.voiceAudioBlob,
      } satisfies StoredDebugHistoryAssets);
      transaction.objectStore(IMAGES_STORE).put({ recordId: artifacts.manifest.recordId, imageBlob: artifacts.imageBlob,
        hasVoice: artifacts.voiceAudioBlob !== null && artifacts.voiceAudioBlob.size > 0 } satisfies StoredDebugHistoryImage);
    } catch (error) {
      // Synchronous quota/clone failures must also roll back writes already
      // queued in this transaction, including the associated draft.
      transaction.abort();
      throw error;
    }
    await transactionDone(transaction);
    notifyBrowserRecordsChanged();
    return getSummary(storedRecord);
  } catch (error) {
    throw asDebugHistoryError(error);
  }
};

export const listDebugHistoryRecords = async (): Promise<DebugHistoryRecordSummary[]> => {
  const database = await openDatabase();
  const transaction = database.transaction(RECORDS_STORE, "readonly");
  const records = await requestResult(transaction.objectStore(RECORDS_STORE).getAll() as IDBRequest<StoredDebugHistoryRecord[]>);
  await transactionDone(transaction);
  return records.map(getSummary).sort((first, second) => second.createdAt.localeCompare(first.createdAt));
};

/** One gallery snapshot reads metadata/images, and only audio keys (not Blobs). */
export const listDebugHistoryGalleryRecords = async () => {
  const database = await openDatabase();
  const transaction = database.transaction([RECORDS_STORE, IMAGES_STORE, ASSETS_STORE], "readonly");
  const completed = transactionDone(transaction);
  const [records, images, audioKeys] = await Promise.all([
    requestResult(transaction.objectStore(RECORDS_STORE).getAll() as IDBRequest<StoredDebugHistoryRecord[]>),
    requestResult(transaction.objectStore(IMAGES_STORE).getAll() as IDBRequest<StoredDebugHistoryImage[]>),
    requestResult(transaction.objectStore(ASSETS_STORE).getAllKeys()),
    completed,
  ]);
  const imagesById = new Map(images.map(image => [image.recordId, image]));
  const audioIds = new Set(audioKeys);
  const available: { summary: DebugHistoryRecordSummary; imageBlob: Blob }[] = [];
  let skippedCount = 0;
  for (const record of records) {
    const manifest = record.manifest;
    if (!manifest) { skippedCount++; continue; }
    // Lyrics-only/failed generations are valid records, but not gallery songs.
    if (!manifest.lyrics || !manifest.audio) continue;
    const image = imagesById.get(record.recordId);
    if (!(image?.imageBlob instanceof Blob) || !image.imageBlob.size || !image.hasVoice || !audioIds.has(record.recordId)
      || typeof manifest.lyrics.title !== "string" || !Array.isArray(manifest.lyrics.lines)
      || !Array.isArray(manifest.drawing?.strokes) || typeof record.createdAt !== "string") {
      skippedCount++;
      continue;
    }
    available.push({ summary: getSummary(record), imageBlob: image.imageBlob });
  }
  return { records: available, skippedCount };
};

export const getDebugHistoryImage = async (recordId: string): Promise<Blob | null> => {
  const database = await openDatabase();
  const transaction = database.transaction(IMAGES_STORE, "readonly");
  const image = await requestResult(transaction.objectStore(IMAGES_STORE).get(recordId) as IDBRequest<StoredDebugHistoryImage | undefined>);
  await transactionDone(transaction);
  return image?.imageBlob instanceof Blob ? image.imageBlob : null;
};

export const getDebugHistoryRecord = async (recordId: string): Promise<DebugHistoryRecord | null> => {
  const database = await openDatabase();
  const transaction = database.transaction([RECORDS_STORE, ASSETS_STORE, IMAGES_STORE], "readonly");
  const record = await requestResult(transaction.objectStore(RECORDS_STORE).get(recordId) as IDBRequest<StoredDebugHistoryRecord | undefined>);
  const assets = await requestResult(transaction.objectStore(ASSETS_STORE).get(recordId) as IDBRequest<StoredDebugHistoryAssets | undefined>);
  const image = await requestResult(transaction.objectStore(IMAGES_STORE).get(recordId) as IDBRequest<StoredDebugHistoryImage | undefined>);
  await transactionDone(transaction);
  if (!record) return null;
  if (!assets || !(image?.imageBlob instanceof Blob)) throw new DebugHistoryError("corrupt", "この作品の画像または音声データが見つかりません。");

  return {
    ...getSummary(record),
    artifacts: {
      manifest: record.manifest,
      imageBlob: image.imageBlob,
      voiceAudioBlob: assets.voiceAudioBlob,
    },
  };
};

export const deleteDebugHistoryRecord = async (recordId: string) => {
  const database = await openDatabase();
  const transaction = database.transaction([RECORDS_STORE, ASSETS_STORE, IMAGES_STORE, EVALUATION_DRAFTS_STORE], "readwrite");
  const drafts = transaction.objectStore(EVALUATION_DRAFTS_STORE);
  const savedDrafts = await requestResult(drafts.getAll() as IDBRequest<StoredEvaluationDraft[]>);
  for (const saved of savedDrafts) {
    if (!saved.recordIds.includes(recordId)) continue;
    const recordIds = saved.recordIds.filter(id => id !== recordId);
    if (recordIds.length) drafts.put({ ...saved, recordIds });
    else drafts.delete(saved.generationId);
  }
  transaction.objectStore(RECORDS_STORE).delete(recordId);
  transaction.objectStore(ASSETS_STORE).delete(recordId);
  transaction.objectStore(IMAGES_STORE).delete(recordId);
  await transactionDone(transaction);
  notifyBrowserRecordsChanged();
};

export const clearDebugHistoryRecords = async () => {
  const database = await openDatabase();
  const transaction = database.transaction([RECORDS_STORE, ASSETS_STORE, IMAGES_STORE, EVALUATION_DRAFTS_STORE], "readwrite");
  transaction.objectStore(RECORDS_STORE).clear();
  transaction.objectStore(ASSETS_STORE).clear();
  transaction.objectStore(IMAGES_STORE).clear();
  transaction.objectStore(EVALUATION_DRAFTS_STORE).clear();
  await transactionDone(transaction);
  notifyBrowserRecordsChanged();
};

export const setDebugHistoryFavorite = async (recordId: string, favorite: boolean) => {
  const database = await openDatabase();
  const transaction = database.transaction(RECORDS_STORE, "readwrite");
  const store = transaction.objectStore(RECORDS_STORE);
  const record = await requestResult(store.get(recordId) as IDBRequest<StoredDebugHistoryRecord | undefined>);
  if (!record) throw new Error("作品が見つかりませんでした。");
  store.put({ ...record, isFavorite: favorite });
  await transactionDone(transaction);
  notifyBrowserRecordsChanged();
};

/** Count attempts once, without retaining the drawing, lyrics or audio. */
export const recordBrowserGeneration = async (recordId: string, startedAt: string) => {
  const database = await openDatabase();
  const transaction = database.transaction(GENERATIONS_STORE, "readwrite");
  const store = transaction.objectStore(GENERATIONS_STORE);
  const existing = await requestResult(store.get(recordId));
  if (!existing) store.put({ recordId, date: japanDate(startedAt), recorded: false } satisfies BrowserGeneration);
  await transactionDone(transaction);
};

export const getBrowserUsageStats = async (): Promise<UsageStats> => {
  const database = await openDatabase();
  const transaction = database.transaction(GENERATIONS_STORE, "readonly");
  const entries = await requestResult(transaction.objectStore(GENERATIONS_STORE).getAll() as IDBRequest<BrowserGeneration[]>);
  await transactionDone(transaction);
  const days = new Map<string, UsageStats["days"][number]>();
  for (const entry of entries) {
    const day = days.get(entry.date) ?? { date: entry.date, generationCount: 0, recordedCount: 0, unrecordedCount: 0 };
    day.generationCount++;
    if (entry.recorded) day.recordedCount++; else day.unrecordedCount++;
    days.set(entry.date, day);
  }
  const recordedGenerations = entries.filter(entry => entry.recorded).length;
  return { totalGenerations: entries.length, recordedGenerations, unrecordedGenerations: entries.length - recordedGenerations,
    days: [...days.values()].sort((a, b) => b.date.localeCompare(a.date)) };
};

export const getDebugHistoryStats = async (): Promise<DebugHistoryStats> => {
  const [records, estimate] = await Promise.all([listDebugHistoryRecords(), getStorageEstimate()]);
  const database = await openDatabase();
  const transaction = database.transaction(EVALUATION_DRAFTS_STORE, "readonly");
  const drafts = await requestResult(transaction.objectStore(EVALUATION_DRAFTS_STORE).getAll() as IDBRequest<StoredEvaluationDraft[]>);
  await transactionDone(transaction);
  return {
    count: records.length,
    storedBytes: records.reduce((total, record) => total + record.byteSize, 0) + drafts.reduce((total, draft) => total + draft.byteSize, 0),
    originUsageBytes: estimate.usage,
    originQuotaBytes: estimate.quota,
  };
};
