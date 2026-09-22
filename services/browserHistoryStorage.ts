import type { DebugBundleManifest, EvaluationDraft } from "../types";

const DB_NAME = "cho-ekaki-uta-debug-history";
const DB_VERSION = 4;
export const RECORDS_STORE = "records";
export const ASSETS_STORE = "assets";
export const IMAGES_STORE = "images";
export const GENERATIONS_STORE = "generations";
type BrowserGeneration = { recordId: string; date: string; recorded: boolean };
const japanDate = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

export const EVALUATION_DRAFTS_STORE = "evaluationDrafts";
export const BROWSER_HISTORY_MAX_BYTES = 100 * 1024 * 1024;

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


export type StoredEvaluationDraft = { generationId: string; recordIds: string[]; draft: EvaluationDraft; byteSize: number };
export const evaluationDraftByteSize = (draft: EvaluationDraft) => new TextEncoder().encode(JSON.stringify(draft)).byteLength;

let databasePromise: Promise<IDBDatabase> | null = null;

export const requestResult = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });

export const transactionDone = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });

export const openBrowserHistoryDatabase = () => {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("This browser cannot save debug history."));
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
      if (!database.objectStoreNames.contains(EVALUATION_DRAFTS_STORE)) {
        database.createObjectStore(EVALUATION_DRAFTS_STORE, { keyPath: "generationId" });
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
      void migrateLegacyEvaluationDrafts(database).then(() => resolve(database), (error) => { database.close(); databasePromise = null; reject(error); });
    };
    request.onblocked = () => { blocked = true; databasePromise = null; reject(new Error("ほかのタブで開いているアプリを更新してから、もう一度お試しください。")); };
    request.onerror = () => { databasePromise = null; reject(request.error ?? new Error("Failed to open IndexedDB")); };
  });

  return databasePromise;
};

const legacyDraftMatchesRecord = (draft: EvaluationDraft, record: StoredDebugHistoryRecord) => {
  const lyrics = record.manifest?.lyrics;
  const createdAt = Date.parse(draft.createdAt);
  const startedAt = Date.parse(record.manifest?.generation?.startedAt);
  const completedAt = Date.parse(record.manifest?.generation?.completedAt);
  // Old releases did not persist a generationId -> recordId link. Match the
  // candidate's content AND its generation time window, never a title alone.
  return lyrics && Number.isFinite(createdAt) && startedAt <= createdAt && createdAt <= completedAt
    && Array.isArray(draft.candidates) && draft.candidates.some(candidate => candidate.title === lyrics.title
      && candidate.identifiedObject === lyrics.identifiedObject
      && JSON.stringify(candidate.lines) === JSON.stringify(lyrics.lines));
};

/** Move legacy drafts beside their records, then remove the old copies/orphans. */
const migrateLegacyEvaluationDrafts = async (database: IDBDatabase) => {
  const legacyName = "cho-ekaki-uta-evaluation-drafts";
  // Retire version 1 even when it was never created. Otherwise an old tab can
  // open it later and write new orphan drafts after this app deletes/clears.
  // Waiting for the upgrade also fences existing version-1 writers before we
  // take the migration snapshot. Those old connections did not handle
  // versionchange, so give a bounded, actionable error instead of hanging.
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const opening = indexedDB.open(legacyName, 2);
    opening.onblocked = () => {
      blocked = true;
      reject(new Error("ほかのタブで開いているアプリを閉じてから、もう一度お試しください。保存済みの作品は保持されています。"));
    };
    opening.onsuccess = () => {
      if (blocked) { opening.result.close(); return; }
      resolve(opening.result);
    };
    opening.onerror = () => reject(opening.error ?? new Error("Failed to retire legacy evaluation storage"));
  });
  legacy.onversionchange = () => legacy.close();
  try {
    if (!legacy.objectStoreNames.contains("drafts")) return;
    const reading = legacy.transaction("drafts", "readonly");
    const oldDrafts = await requestResult(reading.objectStore("drafts").getAll() as IDBRequest<EvaluationDraft[]>);
    await transactionDone(reading);
    if (!oldDrafts.length) return;

    const migration = database.transaction([RECORDS_STORE, EVALUATION_DRAFTS_STORE], "readwrite");
    const records = await requestResult(migration.objectStore(RECORDS_STORE).getAll() as IDBRequest<StoredDebugHistoryRecord[]>);
    const store = migration.objectStore(EVALUATION_DRAFTS_STORE);
    const current = await requestResult(store.getAll() as IDBRequest<StoredEvaluationDraft[]>);
    for (const draft of oldDrafts) {
      if (typeof draft.generationId !== "string") continue;
      const recordIds = records.filter(record => legacyDraftMatchesRecord(draft, record)).map(record => record.recordId);
      // If two old records are indistinguishable, retain the draft until both
      // are deleted instead of guessing which saved work owns it.
      if (recordIds.length && !current.some(entry => entry.generationId === draft.generationId)) {
        store.put({ generationId: draft.generationId, recordIds, draft,
          byteSize: evaluationDraftByteSize(draft) } satisfies StoredEvaluationDraft);
      }
    }
    await transactionDone(migration);

    // Cleanup is retryable after a crash. The version barrier above prevents
    // old tabs from writing into this database during or after migration.
    const cleanup = legacy.transaction("drafts", "readwrite");
    const oldStore = cleanup.objectStore("drafts");
    for (const draft of oldDrafts) {
      const latest = await requestResult(oldStore.get(draft.generationId));
      if (JSON.stringify(latest) === JSON.stringify(draft)) oldStore.delete(draft.generationId);
    }
    await transactionDone(cleanup);
  } finally {
    legacy.close();
  }
};
