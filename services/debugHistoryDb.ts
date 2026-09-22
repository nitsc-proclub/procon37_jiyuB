import { DebugBundleArtifacts } from "./debugBundleService";
import { DebugBundleManifest, UsageStats } from "../types";
import { notifyBrowserRecordsChanged } from "./browserRecordEvents";

export const DEBUG_HISTORY_MAX_RECORDS = 50;
export const DEBUG_HISTORY_MAX_BYTES = 100 * 1024 * 1024;

const DB_NAME = "cho-ekaki-uta-debug-history";
const DB_VERSION = 3;
const RECORDS_STORE = "records";
const ASSETS_STORE = "assets";
const IMAGES_STORE = "images";
const GENERATIONS_STORE = "generations";
type BrowserGeneration = { recordId: string; date: string; recorded: boolean };
const japanDate = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

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

let databasePromise: Promise<IDBDatabase> | null = null;
const textEncoder = new TextEncoder();

const requestResult = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });

const transactionDone = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });

const openDatabase = () => {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new DebugHistoryError("unsupported", "This browser cannot save debug history."));
  }

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RECORDS_STORE)) {
        const records = database.createObjectStore(RECORDS_STORE, { keyPath: "recordId" });
        records.createIndex("createdAt", "createdAt");
      }
      if (!database.objectStoreNames.contains(ASSETS_STORE)) {
        database.createObjectStore(ASSETS_STORE, { keyPath: "recordId" });
      }
      if (!database.objectStoreNames.contains(IMAGES_STORE)) {
        const images = database.createObjectStore(IMAGES_STORE, { keyPath: "recordId" });
        // Split existing assets once, atomically. Gallery refreshes then read
        // images independently without cloning every saved audio Blob.
        const cursor = request.transaction!.objectStore(ASSETS_STORE).openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) return;
          const asset = current.value as StoredDebugHistoryAssets & { imageBlob?: Blob };
          if (asset.imageBlob instanceof Blob) images.put({ recordId: asset.recordId, imageBlob: asset.imageBlob,
            hasVoice: asset.voiceAudioBlob instanceof Blob && asset.voiceAudioBlob.size > 0 } satisfies StoredDebugHistoryImage);
          current.update({ recordId: asset.recordId, voiceAudioBlob: asset.voiceAudioBlob } satisfies StoredDebugHistoryAssets);
          current.continue();
        };
      }
      if (!database.objectStoreNames.contains(GENERATIONS_STORE)) {
        const generations = database.createObjectStore(GENERATIONS_STORE, { keyPath: "recordId" });
        // Older public builds only retained saved records. Recover those once;
        // unknown unsaved generations cannot be reconstructed.
        const cursor = request.transaction!.objectStore(RECORDS_STORE).openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) return;
          const record = current.value as StoredDebugHistoryRecord;
          const startedAt = record.manifest?.generation?.startedAt;
          if (startedAt && Number.isFinite(Date.parse(startedAt))) {
            generations.put({ recordId: record.recordId, date: japanDate(startedAt), recorded: true } satisfies BrowserGeneration);
          }
          current.continue();
        };
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) { database.close(); return; }
      database.onversionchange = () => { database.close(); databasePromise = null; };
      resolve(database);
    };
    request.onblocked = () => { blocked = true; databasePromise = null; reject(new Error("ほかのタブで開いているアプリを更新してから、もう一度お試しください。")); };
    request.onerror = () => { databasePromise = null; reject(request.error ?? new Error("Failed to open IndexedDB")); };
  });

  return databasePromise;
};

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
export const saveDebugHistoryRecord = async (artifacts: DebugBundleArtifacts): Promise<DebugHistoryRecordSummary> => {
  if ((artifacts.manifest.audio !== null) !== (artifacts.voiceAudioBlob !== null)) {
    throw new DebugHistoryError("corrupt", "Voice metadata and audio do not match.");
  }

  const byteSize = getArtifactByteSize(artifacts);
  if (byteSize > DEBUG_HISTORY_MAX_BYTES) {
    throw new DebugHistoryError("size-limit", "This record is larger than the debug history limit.");
  }

  const estimate = await getStorageEstimate();
  if (estimate.usage !== null && estimate.quota !== null && estimate.quota - estimate.usage < byteSize) {
    throw new DebugHistoryError("origin-quota", "This browser does not have enough free storage.");
  }

  try {
    const database = await openDatabase();
    const transaction = database.transaction([RECORDS_STORE, ASSETS_STORE, IMAGES_STORE, GENERATIONS_STORE], "readwrite");
    const recordsStore = transaction.objectStore(RECORDS_STORE);
    const records = await requestResult(recordsStore.getAll() as IDBRequest<StoredDebugHistoryRecord[]>);
    const generations = transaction.objectStore(GENERATIONS_STORE);
    const generation = await requestResult(generations.get(artifacts.manifest.recordId) as IDBRequest<BrowserGeneration | undefined>);
    const replacing = records.find((record) => record.recordId === artifacts.manifest.recordId);
    const remainingRecords = replacing ? records.filter((record) => record.recordId !== replacing.recordId) : records;
    const storedBytes = remainingRecords.reduce((total, record) => total + record.byteSize, 0);

    if (!replacing && records.length >= DEBUG_HISTORY_MAX_RECORDS) {
      transaction.abort();
      throw new DebugHistoryError("record-limit", "The debug history already contains 50 records.");
    }
    if (storedBytes + byteSize > DEBUG_HISTORY_MAX_BYTES) {
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
    recordsStore.put(storedRecord);
    if (generation) generations.put({ ...generation, recorded: true });
    transaction.objectStore(ASSETS_STORE).put({
      recordId: artifacts.manifest.recordId,
      voiceAudioBlob: artifacts.voiceAudioBlob,
    } satisfies StoredDebugHistoryAssets);
    transaction.objectStore(IMAGES_STORE).put({ recordId: artifacts.manifest.recordId, imageBlob: artifacts.imageBlob,
      hasVoice: artifacts.voiceAudioBlob !== null && artifacts.voiceAudioBlob.size > 0 } satisfies StoredDebugHistoryImage);
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
  const transaction = database.transaction([RECORDS_STORE, ASSETS_STORE, IMAGES_STORE], "readwrite");
  transaction.objectStore(RECORDS_STORE).delete(recordId);
  transaction.objectStore(ASSETS_STORE).delete(recordId);
  transaction.objectStore(IMAGES_STORE).delete(recordId);
  await transactionDone(transaction);
  notifyBrowserRecordsChanged();
};

export const clearDebugHistoryRecords = async () => {
  const database = await openDatabase();
  const transaction = database.transaction([RECORDS_STORE, ASSETS_STORE, IMAGES_STORE], "readwrite");
  transaction.objectStore(RECORDS_STORE).clear();
  transaction.objectStore(ASSETS_STORE).clear();
  transaction.objectStore(IMAGES_STORE).clear();
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
  return {
    count: records.length,
    storedBytes: records.reduce((total, record) => total + record.byteSize, 0),
    originUsageBytes: estimate.usage,
    originQuotaBytes: estimate.quota,
  };
};
