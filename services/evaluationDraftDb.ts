import type { DrawingAnalysis, DrawingSubjectFeedbackChoice, EvaluationCentralConsent, EvaluationDraft, EvaluationSelection, EvaluationStructuredRatings, LyricsCandidate, Phase1ModelInfo } from "../types";

export const EVALUATION_DRAFT_SCHEMA_VERSION = 1 as const;

const DB_NAME = "cho-ekaki-uta-evaluation-drafts";
const DB_VERSION = 1;
const DRAFTS_STORE = "drafts";

export class EvaluationDraftError extends Error {
  constructor(public readonly code: "unsupported" | "storage", message: string) {
    super(message);
    this.name = "EvaluationDraftError";
  }
}

let databasePromise: Promise<IDBDatabase> | null = null;

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
    return Promise.reject(new EvaluationDraftError("unsupported", "This browser cannot save evaluation drafts."));
  }

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DRAFTS_STORE)) {
        const drafts = database.createObjectStore(DRAFTS_STORE, { keyPath: "generationId" });
        drafts.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
  return databasePromise;
};

const asEvaluationDraftError = (error: unknown) =>
  error instanceof EvaluationDraftError ? error : new EvaluationDraftError("storage", "This browser could not save the evaluation draft.");

export const shuffleCandidateIds = <T extends string>(candidateIds: readonly T[], random: () => number = Math.random): T[] => {
  const shuffled = [...candidateIds];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
};

export const createGenerationId = (): string | null => {
  if (typeof crypto === "undefined") return null;
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto.getRandomValues !== "function") return null;

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // RFC 4122 version 4 and variant bits. getRandomValues keeps this fallback
  // collision-resistant without falling back to Math.random.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const isComparableCandidateSet = (candidates: LyricsCandidate[] | null): candidates is [LyricsCandidate, LyricsCandidate] =>
  !!candidates && candidates.length === 2 && new Set(candidates.map((candidate) => candidate.candidateId)).size === 2;

/** Resolves an existing candidate ID without changing its identity or order. */
export const getInitialPreviewCandidate = (
  candidates: readonly LyricsCandidate[],
  displayOrder: readonly LyricsCandidate["candidateId"][],
): LyricsCandidate | null => {
  const firstCandidateId = displayOrder[0];
  return candidates.find((candidate) => candidate.candidateId === firstCandidateId) ?? null;
};

const copyCandidate = (candidate: LyricsCandidate): LyricsCandidate => ({
  candidateId: candidate.candidateId,
  title: candidate.title,
  lines: [...candidate.lines],
  singingKanaLines: candidate.singingKanaLines ? [...candidate.singingKanaLines] : undefined,
  identifiedObject: candidate.identifiedObject,
  lineStrokeMappings: candidate.lineStrokeMappings?.map((mapping) => ({
    lineIndex: mapping.lineIndex,
    strokeGroupIds: [...mapping.strokeGroupIds],
  })),
  modelName: candidate.modelName,
});

const copyDrawingAnalysis = (drawingAnalysis: DrawingAnalysis): DrawingAnalysis => ({
  schemaVersion: drawingAnalysis.schemaVersion,
  objectCandidates: drawingAnalysis.objectCandidates.map((candidate) => ({
    label: candidate.label,
    confidence: candidate.confidence,
  })),
  parts: drawingAnalysis.parts.map((part) => ({
    id: part.id,
    shape: part.shape,
    position: part.position,
    strokeGroupIds: [...part.strokeGroupIds],
  })),
  drawingOrder: [...drawingAnalysis.drawingOrder],
});

type CreateEvaluationDraftInput = {
  generationId: string;
  createdAt: string;
  candidates: readonly LyricsCandidate[];
  displayOrder: readonly LyricsCandidate["candidateId"][];
  drawingAnalysis: DrawingAnalysis;
  modelInfo: Phase1ModelInfo;
  lyricsPromptVersion: string | null;
  activeCandidateId?: LyricsCandidate["candidateId"] | null;
};

/**
 * Builds the only browser-persisted evaluation shape. Its input deliberately
 * excludes DrawingData, Blob/audio, participant age, and arbitrary payloads.
 * The centralConsent field is only the local state of the future consent
 * boundary; it is not a central submission or a consent record.
 */
export const createEvaluationDraft = ({
  generationId,
  createdAt,
  candidates,
  displayOrder,
  drawingAnalysis,
  modelInfo,
  lyricsPromptVersion,
  activeCandidateId = null,
}: CreateEvaluationDraftInput): EvaluationDraft => ({
  schemaVersion: EVALUATION_DRAFT_SCHEMA_VERSION,
  generationId,
  createdAt,
  updatedAt: createdAt,
  candidates: candidates.map(copyCandidate),
  displayOrder: [...displayOrder],
  selection: null,
  firstImpressionSelection: null,
  finalPreferenceSelection: null,
  activeCandidateId,
  alternativePreviewed: false,
  centralConsent: "not-asked",
  subjectFeedbackChoice: null,
  ratings: {},
  followUpCentralConsent: "not-asked",
  drawingAnalysis: copyDrawingAnalysis(drawingAnalysis),
  modelInfo: {
    drawingAnalysis: modelInfo.drawingAnalysis,
    lyricsGeneration: modelInfo.lyricsGeneration,
  },
  drawingAnalysisSchemaVersion: drawingAnalysis.schemaVersion,
  lyricsPromptVersion,
});

export const withEvaluationDraftSelection = (
  draft: EvaluationDraft,
  selection: EvaluationSelection,
  updatedAt: string,
): EvaluationDraft => {
  const firstImpressionSelection = draft.firstImpressionSelection ?? selection;
  return {
    ...draft,
    selection: firstImpressionSelection,
    firstImpressionSelection,
    finalPreferenceSelection: draft.finalPreferenceSelection ?? firstImpressionSelection,
    updatedAt,
  };
};

export const saveEvaluationDraft = async (draft: EvaluationDraft): Promise<void> => {
  try {
    const database = await openDatabase();
    const transaction = database.transaction(DRAFTS_STORE, "readwrite");
    transaction.objectStore(DRAFTS_STORE).put(draft);
    await transactionDone(transaction);
  } catch (error) {
    throw asEvaluationDraftError(error);
  }
};

export const getEvaluationDraft = async (generationId: string): Promise<EvaluationDraft | null> => {
  try {
    const database = await openDatabase();
    const transaction = database.transaction(DRAFTS_STORE, "readonly");
    const draft = await requestResult(transaction.objectStore(DRAFTS_STORE).get(generationId) as IDBRequest<EvaluationDraft | undefined>);
    await transactionDone(transaction);
    return draft ?? null;
  } catch (error) {
    throw asEvaluationDraftError(error);
  }
};

export const updateEvaluationDraftSelection = async (
  generationId: string,
  selection: EvaluationSelection,
  updatedAt: string,
): Promise<boolean> => {
  try {
    const database = await openDatabase();
    const transaction = database.transaction(DRAFTS_STORE, "readwrite");
    const store = transaction.objectStore(DRAFTS_STORE);
    const existing = await requestResult(store.get(generationId) as IDBRequest<EvaluationDraft | undefined>);
    if (existing) store.put(withEvaluationDraftSelection(existing, selection, updatedAt));
    await transactionDone(transaction);
    return !!existing;
  } catch (error) {
    throw asEvaluationDraftError(error);
  }
};

export type EvaluationDraftStatePatch = {
  firstImpressionSelection?: EvaluationSelection;
  finalPreferenceSelection?: EvaluationSelection;
  activeCandidateId?: LyricsCandidate["candidateId"] | null;
  alternativePreviewed?: boolean;
  centralConsent?: EvaluationCentralConsent;
  subjectFeedbackChoice?: DrawingSubjectFeedbackChoice | null;
  ratings?: EvaluationStructuredRatings;
  followUpCentralConsent?: EvaluationCentralConsent;
};

/** Updates only the whitelisted local evaluation state; no drawing or media can enter the draft. */
export const updateEvaluationDraftState = async (
  generationId: string,
  patch: EvaluationDraftStatePatch,
  updatedAt: string,
): Promise<boolean> => {
  try {
    const database = await openDatabase();
    const transaction = database.transaction(DRAFTS_STORE, "readwrite");
    const store = transaction.objectStore(DRAFTS_STORE);
    const existing = await requestResult(store.get(generationId) as IDBRequest<EvaluationDraft | undefined>);
    if (existing) {
      const nextFirstImpressionSelection = patch.firstImpressionSelection ?? existing.firstImpressionSelection ?? existing.selection;
      const nextFinalPreferenceSelection = patch.finalPreferenceSelection !== undefined
        ? patch.finalPreferenceSelection
        : existing.finalPreferenceSelection ?? nextFirstImpressionSelection;
      store.put({
        ...existing,
        ...patch,
        // Keep the old `selection` field as a compatibility mirror. It is
        // intentionally never changed by later alternative previews.
        selection: nextFirstImpressionSelection,
        firstImpressionSelection: nextFirstImpressionSelection,
        finalPreferenceSelection: nextFinalPreferenceSelection,
        updatedAt,
      });
    }
    await transactionDone(transaction);
    return !!existing;
  } catch (error) {
    throw asEvaluationDraftError(error);
  }
};
