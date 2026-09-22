import { openBrowserHistoryDatabase as openDatabase, requestResult, transactionDone, EVALUATION_DRAFTS_STORE, RECORDS_STORE, BROWSER_HISTORY_MAX_BYTES, evaluationDraftByteSize, type StoredEvaluationDraft } from "./browserHistoryStorage";
import type { DrawingAnalysis, DrawingSubjectFeedbackChoice, EvaluationCentralConsent, EvaluationDraft, EvaluationSelection, EvaluationStructuredRatings, LyricsCandidate, Phase1ModelInfo } from "../types";

export const EVALUATION_DRAFT_SCHEMA_VERSION = 1 as const;

export class EvaluationDraftError extends Error {
  constructor(public readonly code: "unsupported" | "storage", message: string) {
    super(message);
    this.name = "EvaluationDraftError";
  }
}

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
  drawingAnalysis: DrawingAnalysis | null;
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
  drawingAnalysis: drawingAnalysis ? copyDrawingAnalysis(drawingAnalysis) : null,
  modelInfo: {
    drawingAnalysis: modelInfo.drawingAnalysis,
    lyricsGeneration: modelInfo.lyricsGeneration,
  },
  drawingAnalysisSchemaVersion: drawingAnalysis?.schemaVersion ?? 1,
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

/** Updates an already-saved draft; record creation is atomic in saveDebugHistoryRecord. */
export const saveEvaluationDraft = async (draft: EvaluationDraft): Promise<boolean> =>
  updateStoredDraft(draft.generationId, existing => existing.updatedAt > draft.updatedAt ? existing : draft);

const updateStoredDraft = async (generationId: string, update: (draft: EvaluationDraft) => EvaluationDraft): Promise<boolean> => {
  try {
    const database = await openDatabase();
    const transaction = database.transaction([EVALUATION_DRAFTS_STORE, RECORDS_STORE], "readwrite");
    const store = transaction.objectStore(EVALUATION_DRAFTS_STORE);
    const drafts = await requestResult(store.getAll() as IDBRequest<StoredEvaluationDraft[]>);
    const existing = drafts.find(entry => entry.generationId === generationId);
    if (!existing) { await transactionDone(transaction); return false; }
    const records = await requestResult(transaction.objectStore(RECORDS_STORE).getAll() as IDBRequest<{ recordId: string; byteSize: number }[]>);
    const recordIds = existing.recordIds.filter(id => records.some(record => record.recordId === id));
    if (!recordIds.length) {
      store.delete(generationId);
      await transactionDone(transaction);
      return false;
    }
    const draft = update(existing.draft);
    const byteSize = evaluationDraftByteSize(draft);
    const storedBytes = records.reduce((total, record) => total + record.byteSize, 0)
      + drafts.reduce((total, entry) => total + entry.byteSize, 0) - existing.byteSize + byteSize;
    if (storedBytes > BROWSER_HISTORY_MAX_BYTES) {
      transaction.abort();
      throw new EvaluationDraftError("storage", "The saved records would exceed 100 MB.");
    }
    store.put({ ...existing, recordIds, draft, byteSize } satisfies StoredEvaluationDraft);
    await transactionDone(transaction);
    return true;
  } catch (error) { throw asEvaluationDraftError(error); }
};

export const getEvaluationDraft = async (generationId: string): Promise<EvaluationDraft | null> => {
  try {
    const database = await openDatabase();
    const transaction = database.transaction(EVALUATION_DRAFTS_STORE, "readonly");
    const draft = await requestResult(transaction.objectStore(EVALUATION_DRAFTS_STORE).get(generationId) as IDBRequest<StoredEvaluationDraft | undefined>);
    await transactionDone(transaction);
    return draft?.draft ?? null;
  } catch (error) {
    throw asEvaluationDraftError(error);
  }
};

export const updateEvaluationDraftSelection = async (
  generationId: string,
  selection: EvaluationSelection,
  updatedAt: string,
): Promise<boolean> => updateStoredDraft(generationId, draft => withEvaluationDraftSelection(draft, selection, updatedAt));

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

/** Applies the allowlisted state changes without touching browser storage. */
export const withEvaluationDraftState = (
  draft: EvaluationDraft,
  patch: EvaluationDraftStatePatch,
  updatedAt: string,
): EvaluationDraft => {
  const nextFirstImpressionSelection = patch.firstImpressionSelection ?? draft.firstImpressionSelection ?? draft.selection;
  const nextFinalPreferenceSelection = patch.finalPreferenceSelection !== undefined
    ? patch.finalPreferenceSelection
    : draft.finalPreferenceSelection ?? nextFirstImpressionSelection;
  return {
    ...draft,
    ...patch,
    // Keep the old `selection` field as a compatibility mirror. It is
    // intentionally never changed by later alternative previews.
    selection: nextFirstImpressionSelection,
    firstImpressionSelection: nextFirstImpressionSelection,
    finalPreferenceSelection: nextFinalPreferenceSelection,
    updatedAt,
  };
};

/** Updates only the whitelisted local evaluation state; no drawing or media can enter the draft. */
export const updateEvaluationDraftState = async (
  generationId: string,
  patch: EvaluationDraftStatePatch,
  updatedAt: string,
): Promise<boolean> => updateStoredDraft(generationId, draft => withEvaluationDraftState(draft, patch, updatedAt));
