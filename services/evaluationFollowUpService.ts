import type {
  DrawingSubjectFeedbackChoice,
  EvaluationDraft,
  EvaluationFollowUpSubmissionPayload,
  EvaluationFollowUpSubmissionResponse,
  EvaluationRatingDimension,
  EvaluationRatingValue,
  EvaluationSelection,
  EvaluationStructuredRatings,
  EvaluationSubmissionPayload,
  LyricsCandidate,
} from "../types";
import {
  EvaluationDatabase,
  EvaluationSubmissionError,
  validateEvaluationSubmission,
} from "./evaluationSubmissionService";

export const EVALUATION_FOLLOW_UP_MAX_BYTES = 16 * 1024;

const CANDIDATE_IDS = new Set<LyricsCandidate["candidateId"]>(["candidate-a", "candidate-b"]);
const SUBJECT_CHOICES = new Set<DrawingSubjectFeedbackChoice>(["primary", "alternate-1", "alternate-2", "other"]);
const RATING_DIMENSIONS = ["drawingSongQuality", "drawingOrderClarity", "childFriendliness", "singability"] as const satisfies readonly EvaluationRatingDimension[];
const RATING_VALUES = new Set<EvaluationRatingValue>(["good", "okay", "needs-work"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const isIsoDate = (value: unknown) => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const isFinalPreference = (value: unknown): value is Exclude<EvaluationSelection, null> =>
  value === "neither" || (typeof value === "string" && CANDIDATE_IDS.has(value as LyricsCandidate["candidateId"]));
const isSubjectChoice = (value: unknown): value is DrawingSubjectFeedbackChoice =>
  typeof value === "string" && SUBJECT_CHOICES.has(value as DrawingSubjectFeedbackChoice);

const FOLLOW_UP_KEYS = [
  "schemaVersion",
  "generationId",
  "evaluationReceipt",
  "updatedAt",
  "finalPreferenceSelection",
  "subjectFeedbackChoice",
  "ratings",
] as const;

const validateRatings = (value: unknown): value is EvaluationStructuredRatings => {
  if (!isRecord(value) || !Object.keys(value).every((key) => RATING_DIMENSIONS.includes(key as EvaluationRatingDimension))) return false;
  return Object.values(value).every((rating) => typeof rating === "string" && RATING_VALUES.has(rating as EvaluationRatingValue));
};

export const validateEvaluationFollowUpSubmission = (value: unknown): EvaluationFollowUpSubmissionPayload => {
  const fail = (): never => {
    throw new EvaluationSubmissionError(400, "invalid-evaluation-follow-up", "追加の回答の形式が正しくありません。");
  };
  if (!isRecord(value) || !hasExactKeys(value, FOLLOW_UP_KEYS)) fail();
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.generationId !== "string" ||
    !UUID_PATTERN.test(record.generationId) ||
    typeof record.evaluationReceipt !== "string" ||
    record.evaluationReceipt.length > 512 ||
    !isIsoDate(record.updatedAt)
  ) fail();
  if (record.finalPreferenceSelection !== null && !isFinalPreference(record.finalPreferenceSelection)) fail();
  if (record.subjectFeedbackChoice !== null && !isSubjectChoice(record.subjectFeedbackChoice)) fail();
  if (!validateRatings(record.ratings)) fail();
  if (record.finalPreferenceSelection === null && record.subjectFeedbackChoice === null && Object.keys(record.ratings as EvaluationStructuredRatings).length === 0) fail();
  return record as unknown as EvaluationFollowUpSubmissionPayload;
};

export const buildEvaluationFollowUpSubmission = (
  draft: EvaluationDraft,
  receipt: string,
): EvaluationFollowUpSubmissionPayload => validateEvaluationFollowUpSubmission({
  schemaVersion: 1,
  generationId: draft.generationId,
  evaluationReceipt: receipt,
  updatedAt: draft.updatedAt,
  finalPreferenceSelection: draft.finalPreferenceSelection ?? draft.firstImpressionSelection,
  subjectFeedbackChoice: draft.subjectFeedbackChoice ?? null,
  ratings: draft.ratings ?? {},
});

/** Converts malformed JSON into the same bounded 400 error as a bad payload. */
export const parseEvaluationFollowUpSubmission = (body: string): EvaluationFollowUpSubmissionPayload => {
  try {
    return validateEvaluationFollowUpSubmission(JSON.parse(body));
  } catch (error) {
    if (error instanceof EvaluationSubmissionError) throw error;
    throw new EvaluationSubmissionError(400, "invalid-evaluation-follow-up", "追加の回答の形式が正しくありません。");
  }
};

export const submitEvaluationFollowUp = async (
  payload: EvaluationFollowUpSubmissionPayload,
): Promise<EvaluationFollowUpSubmissionResponse> => {
  const body = JSON.stringify(payload);
  if (encoder.encode(body).byteLength > EVALUATION_FOLLOW_UP_MAX_BYTES) {
    throw new EvaluationSubmissionError(413, "evaluation-follow-up-too-large", "追加の回答が大きすぎます。");
  }
  const response = await fetch("/api/evaluations/follow-up", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const result = await response.json().catch(() => ({})) as Partial<EvaluationFollowUpSubmissionResponse> & { error?: string; code?: string };
  if (!response.ok) {
    throw new EvaluationSubmissionError(response.status, result.code ?? "evaluation-follow-up-save-failed", result.error ?? "追加の回答を保存できませんでした。");
  }
  return result as EvaluationFollowUpSubmissionResponse;
};

type StoredEvaluationRow = { evaluation_json: string; status: "pending" | "approved" | "excluded" };

/**
 * Loads the immutable base evaluation and revalidates it before a follow-up is
 * accepted. The client never supplies candidate titles or subject labels.
 */
export const loadStoredEvaluationForFollowUp = async (
  database: EvaluationDatabase,
  generationId: string,
  evaluationReceipt: string,
): Promise<EvaluationSubmissionPayload> => {
  const row = await database
    .prepare("SELECT evaluation_json, status FROM evaluation_records WHERE generation_id = ?")
    .bind(generationId)
    .first<StoredEvaluationRow>();
  if (!row) throw new EvaluationSubmissionError(404, "evaluation-not-found", "先に保存した評価が見つかりません。");
  if (row.status !== "pending") {
    throw new EvaluationSubmissionError(409, "evaluation-already-reviewed", "この評価は確認済みのため、追加の回答は送れません。端末には保存できます。");
  }
  try {
    const stored = JSON.parse(row.evaluation_json) as unknown;
    if (!isRecord(stored)) throw new Error("Stored evaluation is not an object");
    return validateEvaluationSubmission({ ...stored, evaluationReceipt });
  } catch (error) {
    if (error instanceof EvaluationSubmissionError) throw error;
    throw new EvaluationSubmissionError(500, "invalid-stored-evaluation", "保存済みの評価を確認できませんでした。");
  }
};

const subjectLabelForChoice = (
  base: EvaluationSubmissionPayload,
  choice: DrawingSubjectFeedbackChoice | null,
): string | null => {
  if (choice === null) return null;
  if (choice === "other") return "その他";
  const index = choice === "primary" ? 0 : choice === "alternate-1" ? 1 : 2;
  const label = base.drawingAnalysis.objectCandidates[index]?.label?.trim();
  if (!label) {
    throw new EvaluationSubmissionError(400, "invalid-subject-feedback-choice", "その題材候補は選べません。");
  }
  return label;
};

type ExistingFollowUpRow = {
  final_preference_selection: Exclude<EvaluationSelection, null> | null;
  subject_feedback_choice: DrawingSubjectFeedbackChoice | null;
  subject_feedback_label: string | null;
  rating_drawing_song_quality: EvaluationRatingValue | null;
  rating_drawing_order_clarity: EvaluationRatingValue | null;
  rating_child_friendliness: EvaluationRatingValue | null;
  rating_singability: EvaluationRatingValue | null;
};

/** Upserts only bounded, server-derived follow-up fields; the base evaluation is never updated. */
export const saveEvaluationFollowUp = async (
  database: EvaluationDatabase,
  base: EvaluationSubmissionPayload,
  followUp: EvaluationFollowUpSubmissionPayload,
  now = new Date().toISOString(),
) => {
  if (followUp.finalPreferenceSelection && followUp.finalPreferenceSelection !== "neither" && !base.candidates.some((candidate) => candidate.candidateId === followUp.finalPreferenceSelection)) {
    throw new EvaluationSubmissionError(400, "invalid-final-preference", "その歌詞候補は選べません。");
  }
  const subjectFeedbackLabel = subjectLabelForChoice(base, followUp.subjectFeedbackChoice);
  const existing = await database
    .prepare("SELECT final_preference_selection, subject_feedback_choice, subject_feedback_label, rating_drawing_song_quality, rating_drawing_order_clarity, rating_child_friendliness, rating_singability FROM evaluation_followups WHERE generation_id = ?")
    .bind(followUp.generationId)
    .first<ExistingFollowUpRow>();
  // The payload is a complete snapshot of the bounded modal. Null/missing
  // optional answers deliberately clear an earlier answer.
  const nextFinalPreference = followUp.finalPreferenceSelection;
  const nextSubjectChoice = followUp.subjectFeedbackChoice;
  const nextSubjectLabel = subjectFeedbackLabel;
  const nextRatings = {
    drawingSongQuality: followUp.ratings.drawingSongQuality ?? null,
    drawingOrderClarity: followUp.ratings.drawingOrderClarity ?? null,
    childFriendliness: followUp.ratings.childFriendliness ?? null,
    singability: followUp.ratings.singability ?? null,
  };
  if (nextFinalPreference === null && nextSubjectChoice === null && Object.values(nextRatings).every((rating) => rating === null)) {
    throw new EvaluationSubmissionError(400, "empty-evaluation-follow-up", "追加の回答がありません。");
  }
  if (
    existing &&
    existing.final_preference_selection === nextFinalPreference &&
    existing.subject_feedback_choice === nextSubjectChoice &&
    existing.subject_feedback_label === nextSubjectLabel &&
    existing.rating_drawing_song_quality === nextRatings.drawingSongQuality &&
    existing.rating_drawing_order_clarity === nextRatings.drawingOrderClarity &&
    existing.rating_child_friendliness === nextRatings.childFriendliness &&
    existing.rating_singability === nextRatings.singability
  ) {
    return { saved: true as const, duplicate: true as const };
  }
  const writeResult = await database.prepare(
    "INSERT INTO evaluation_followups (generation_id, created_at, updated_at, consented_at, final_preference_selection, subject_feedback_choice, subject_feedback_label, rating_drawing_song_quality, rating_drawing_order_clarity, rating_child_friendliness, rating_singability) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM evaluation_records WHERE generation_id = ? AND status = 'pending') ON CONFLICT(generation_id) DO UPDATE SET updated_at = excluded.updated_at, consented_at = excluded.consented_at, final_preference_selection = excluded.final_preference_selection, subject_feedback_choice = excluded.subject_feedback_choice, subject_feedback_label = excluded.subject_feedback_label, rating_drawing_song_quality = excluded.rating_drawing_song_quality, rating_drawing_order_clarity = excluded.rating_drawing_order_clarity, rating_child_friendliness = excluded.rating_child_friendliness, rating_singability = excluded.rating_singability WHERE EXISTS (SELECT 1 FROM evaluation_records WHERE generation_id = excluded.generation_id AND status = 'pending')",
  ).bind(
    followUp.generationId,
    now,
    now,
    now,
    nextFinalPreference,
    nextSubjectChoice,
    nextSubjectLabel,
    nextRatings.drawingSongQuality,
    nextRatings.drawingOrderClarity,
    nextRatings.childFriendliness,
    nextRatings.singability,
    followUp.generationId,
  ).run();
  if ((writeResult.meta?.changes ?? 0) === 0) {
    throw new EvaluationSubmissionError(409, "evaluation-already-reviewed", "この評価は確認済みのため、追加の回答は送れません。端末には保存できます。");
  }
  return { saved: true as const, duplicate: false as const };
};
