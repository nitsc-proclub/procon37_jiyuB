import { DebugBundleArtifacts } from "./debugBundleService";
import { DebugBundleManifest } from "../types";

export const DEBUG_HISTORY_MAX_RECORDS = 50;
export const DEBUG_HISTORY_MAX_BYTES = 100 * 1024 * 1024;

const DB_NAME = "cho-ekaki-uta-debug-history";
const DB_VERSION = 1;
const RECORDS_STORE = "records";
const ASSETS_STORE = "assets";

type StoredDebugHistoryRecord = {
  recordId: string;
  createdAt: string;
  manifest: DebugBundleManifest;
  byteSize: number;
};

type StoredDebugHistoryAssets = {
  recordId: string;
  imageBlob: Blob;
  voiceAudioBlob: Blob | null;
};

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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });

  return databasePromise;
};

const getSummary = (record: StoredDebugHistoryRecord): DebugHistoryRecordSummary => ({
  ...record,
  title: record.manifest.lyrics?.title ?? "歌詞を作る前に終了",
  identifiedObject: record.manifest.lyrics?.identifiedObject ?? "未判定",
  hasVoice: record.manifest.audio !== null,
});

const getArtifactByteSize = (artifacts: DebugBundleArtifacts) =>
  textEncoder.encode(JSON.stringify(artifacts.manifest)).byteLength + artifacts.imageBlob.size + (artifacts.voiceAudioBlob?.size ?? 0);

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
    const transaction = database.transaction([RECORDS_STORE, ASSETS_STORE], "readwrite");
    const recordsStore = transaction.objectStore(RECORDS_STORE);
    const records = await requestResult(recordsStore.getAll() as IDBRequest<StoredDebugHistoryRecord[]>);
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
    };
    recordsStore.put(storedRecord);
    transaction.objectStore(ASSETS_STORE).put({
      recordId: artifacts.manifest.recordId,
      imageBlob: artifacts.imageBlob,
      voiceAudioBlob: artifacts.voiceAudioBlob,
    } satisfies StoredDebugHistoryAssets);
    await transactionDone(transaction);
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

export const getDebugHistoryRecord = async (recordId: string): Promise<DebugHistoryRecord | null> => {
  const database = await openDatabase();
  const transaction = database.transaction([RECORDS_STORE, ASSETS_STORE], "readonly");
  const record = await requestResult(transaction.objectStore(RECORDS_STORE).get(recordId) as IDBRequest<StoredDebugHistoryRecord | undefined>);
  const assets = await requestResult(transaction.objectStore(ASSETS_STORE).get(recordId) as IDBRequest<StoredDebugHistoryAssets | undefined>);
  await transactionDone(transaction);
  if (!record) return null;
  if (!assets) throw new DebugHistoryError("corrupt", "The stored image data is missing.");

  return {
    ...getSummary(record),
    artifacts: {
      manifest: record.manifest,
      imageBlob: assets.imageBlob,
      voiceAudioBlob: assets.voiceAudioBlob,
    },
  };
};

export const deleteDebugHistoryRecord = async (recordId: string) => {
  const database = await openDatabase();
  const transaction = database.transaction([RECORDS_STORE, ASSETS_STORE], "readwrite");
  transaction.objectStore(RECORDS_STORE).delete(recordId);
  transaction.objectStore(ASSETS_STORE).delete(recordId);
  await transactionDone(transaction);
};

export const clearDebugHistoryRecords = async () => {
  const database = await openDatabase();
  const transaction = database.transaction([RECORDS_STORE, ASSETS_STORE], "readwrite");
  transaction.objectStore(RECORDS_STORE).clear();
  transaction.objectStore(ASSETS_STORE).clear();
  await transactionDone(transaction);
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
