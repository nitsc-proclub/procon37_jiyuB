import type { DrawingAnalysis, EvaluationDraft, EvaluationSubmissionPayload, EvaluationSubmissionResponse, LyricsCandidate, Phase1ModelInfo } from "../types";

export const EVALUATION_SUBMISSION_MAX_BYTES = 256 * 1024;
export const DEFAULT_EVALUATION_RECEIPT_TTL_SECONDS = 6 * 60 * 60;
const RECEIPT_VERSION = "v1";
const CANDIDATE_IDS = new Set(["candidate-a", "candidate-b"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const encoder = new TextEncoder();

export type EvaluationDatabaseResult = { meta?: { changes?: number } };
export type EvaluationPreparedStatement = { bind: (...values: unknown[]) => EvaluationPreparedStatement; run: () => Promise<EvaluationDatabaseResult>; first: <T extends Record<string, unknown>>() => Promise<T | null> };
export type EvaluationDatabase = { prepare: (query: string) => EvaluationPreparedStatement };

export class EvaluationSubmissionError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = "EvaluationSubmissionError"; }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const isNonEmptyString = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isIsoDate = (value: unknown) => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const isCandidateId = (value: unknown): value is LyricsCandidate["candidateId"] => typeof value === "string" && CANDIDATE_IDS.has(value);
const canonicalize = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalize) : isRecord(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonicalize(child)])) : value;
const canonicalJson = (value: unknown) => JSON.stringify(canonicalize(value));
const bytesToBase64Url = (bytes: ArrayBuffer) => { let binary = ""; for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); };
const base64UrlToBytes = (value: string) => { if (!/^[A-Za-z0-9_-]+$/.test(value)) return null; try { const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); } catch { return null; } };
const digest = async (value: unknown) => bytesToBase64Url(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(value))));
const importHmacKey = (secret: string, usages: KeyUsage[]) => crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);

type EvaluationFingerprintInput = { drawingAnalysis: DrawingAnalysis; candidates: readonly LyricsCandidate[] };
const fingerprintInput = (payload: EvaluationFingerprintInput) => ({ drawingAnalysis: payload.drawingAnalysis, candidates: payload.candidates });
export const evaluationFingerprint = (payload: EvaluationFingerprintInput) => digest(fingerprintInput(payload));
export const evaluationPayloadHash = ({ evaluationReceipt: _receipt, ...payload }: EvaluationSubmissionPayload) => digest(payload);

export const createEvaluationReceipt = async (generationId: string, payload: EvaluationFingerprintInput, secret: string, now = Date.now(), ttlSeconds = DEFAULT_EVALUATION_RECEIPT_TTL_SECONDS) => {
  if (!UUID_PATTERN.test(generationId) || secret.length < 32) throw new EvaluationSubmissionError(503, "evaluation-config", "評価保存の設定が完了していません。");
  const expiresAtMs = now + Math.max(60, Math.min(ttlSeconds, 24 * 60 * 60)) * 1000;
  const fingerprint = await evaluationFingerprint(payload);
  const message = `${RECEIPT_VERSION}.${generationId}.${expiresAtMs}.${fingerprint}`;
  const signature = await crypto.subtle.sign("HMAC", await importHmacKey(secret, ["sign"]), encoder.encode(message));
  return { value: `${RECEIPT_VERSION}.${expiresAtMs}.${fingerprint}.${bytesToBase64Url(signature)}`, expiresAt: new Date(expiresAtMs).toISOString() };
};

export const verifyEvaluationReceipt = async (receipt: string, generationId: string, payload: EvaluationFingerprintInput, secret: string, now = Date.now()) => {
  if (!UUID_PATTERN.test(generationId) || secret.length < 32 || receipt.length > 512) return false;
  const parts = receipt.split(".");
  if (parts.length !== 4 || parts[0] !== RECEIPT_VERSION || !/^\d+$/.test(parts[1])) return false;
  const expiresAtMs = Number(parts[1]); const fingerprint = await evaluationFingerprint(payload); const signature = base64UrlToBytes(parts[3]);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now || parts[2] !== fingerprint || !signature) return false;
  return crypto.subtle.verify("HMAC", await importHmacKey(secret, ["verify"]), signature, encoder.encode(`${RECEIPT_VERSION}.${generationId}.${expiresAtMs}.${fingerprint}`));
};

const validateCandidate = (value: unknown, groupIds: Set<string>): value is LyricsCandidate => {
  if (!isRecord(value) || !hasExactKeys(value, ["candidateId", "title", "lines", "singingKanaLines", "identifiedObject", "lineStrokeMappings", "modelName"])) return false;
  if (!isCandidateId(value.candidateId) || !isNonEmptyString(value.title, 240) || !isNonEmptyString(value.identifiedObject, 240) || !isNonEmptyString(value.modelName, 128)) return false;
  if (!Array.isArray(value.lines) || value.lines.length < 1 || value.lines.length > 12 || !value.lines.every((line) => isNonEmptyString(line, 500))) return false;
  if (!Array.isArray(value.singingKanaLines) || value.singingKanaLines.length !== value.lines.length || !value.singingKanaLines.every((line) => isNonEmptyString(line, 500))) return false;
  return Array.isArray(value.lineStrokeMappings) && value.lineStrokeMappings.length === value.lines.length && value.lineStrokeMappings.every((mapping, index) => isRecord(mapping) && hasExactKeys(mapping, ["lineIndex", "strokeGroupIds"]) && mapping.lineIndex === index && Array.isArray(mapping.strokeGroupIds) && mapping.strokeGroupIds.every((id) => typeof id === "string" && groupIds.has(id)));
};

const validateAnalysis = (value: unknown, groupIds: Set<string>): value is DrawingAnalysis => {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "objectCandidates", "parts", "drawingOrder"]) || value.schemaVersion !== 1) return false;
  if (!Array.isArray(value.objectCandidates) || value.objectCandidates.length < 1 || value.objectCandidates.length > 5 || !value.objectCandidates.every((item) => isRecord(item) && hasExactKeys(item, ["label", "confidence"]) && isNonEmptyString(item.label, 160) && ["low", "medium", "high"].includes(String(item.confidence)))) return false;
  if (!Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 64) return false;
  const partIds = new Set<string>();
  for (const part of value.parts) {
    if (!isRecord(part) || !hasExactKeys(part, ["id", "shape", "position", "strokeGroupIds"]) || !isNonEmptyString(part.id, 64) || !isNonEmptyString(part.shape, 160) || !isNonEmptyString(part.position, 160) || !Array.isArray(part.strokeGroupIds) || partIds.has(String(part.id)) || !part.strokeGroupIds.every((id) => typeof id === "string" && groupIds.has(id))) return false;
    partIds.add(String(part.id));
  }
  return Array.isArray(value.drawingOrder) && value.drawingOrder.length > 0 && value.drawingOrder.every((id) => typeof id === "string" && partIds.has(id)) && new Set(value.drawingOrder).size === value.drawingOrder.length;
};
const validateModelInfo = (value: unknown): value is Phase1ModelInfo => isRecord(value) && hasExactKeys(value, ["drawingAnalysis", "lyricsGeneration"]) && isNonEmptyString(value.drawingAnalysis, 128) && SAFE_ID_PATTERN.test(String(value.drawingAnalysis)) && isNonEmptyString(value.lyricsGeneration, 128) && SAFE_ID_PATTERN.test(String(value.lyricsGeneration));
const PAYLOAD_KEYS = ["schemaVersion", "generationId", "evaluationReceipt", "createdAt", "updatedAt", "consentedAt", "buildId", "experimentRoundId", "drawingAnalysisSchemaVersion", "lyricsPromptVersion", "firstImpressionSelection", "displayOrder", "candidates", "strokeGroupIds", "drawingAnalysis", "modelInfo", "activeCandidateId", "alternativePreviewed", "centralConsent"] as const;

export const validateEvaluationSubmission = (value: unknown): EvaluationSubmissionPayload => {
  const fail = (code = "invalid-evaluation-payload"): never => { throw new EvaluationSubmissionError(400, code, "評価データの形式が正しくありません。"); };
  if (!isRecord(value)) fail();
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, PAYLOAD_KEYS) || record.schemaVersion !== 1 || typeof record.generationId !== "string" || !UUID_PATTERN.test(record.generationId) || typeof record.evaluationReceipt !== "string" || record.evaluationReceipt.length > 512) fail();
  if (![record.createdAt, record.updatedAt, record.consentedAt].every(isIsoDate) || !isNonEmptyString(record.buildId, 128) || (record.experimentRoundId !== null && (!isNonEmptyString(record.experimentRoundId, 128) || !SAFE_ID_PATTERN.test(String(record.experimentRoundId)))) || record.drawingAnalysisSchemaVersion !== 1 || (record.lyricsPromptVersion !== null && !isNonEmptyString(record.lyricsPromptVersion, 64))) fail();
  if (!isCandidateId(record.firstImpressionSelection) && record.firstImpressionSelection !== "neither") fail("invalid-selection");
  if (!Array.isArray(record.displayOrder) || record.displayOrder.length !== 2 || !record.displayOrder.every(isCandidateId) || new Set(record.displayOrder).size !== 2) fail();
  if (!Array.isArray(record.strokeGroupIds) || record.strokeGroupIds.length < 1 || record.strokeGroupIds.length > 256 || !record.strokeGroupIds.every((id) => typeof id === "string" && SAFE_ID_PATTERN.test(id)) || new Set(record.strokeGroupIds).size !== record.strokeGroupIds.length) fail();
  const groupIds = new Set(record.strokeGroupIds as string[]);
  if (!Array.isArray(record.candidates) || record.candidates.length !== 2 || !record.candidates.every((candidate) => validateCandidate(candidate, groupIds)) || new Set(record.candidates.map((candidate) => candidate.candidateId)).size !== 2) fail();
  if (!validateAnalysis(record.drawingAnalysis, groupIds) || !validateModelInfo(record.modelInfo) || (record.activeCandidateId !== null && !isCandidateId(record.activeCandidateId)) || typeof record.alternativePreviewed !== "boolean" || record.centralConsent !== "accepted") fail();
  return record as unknown as EvaluationSubmissionPayload;
};

export const buildEvaluationSubmission = (draft: EvaluationDraft, receipt: string, buildId: string, consentedAt: string, experimentRoundId: string | null): EvaluationSubmissionPayload => {
  if (!draft.firstImpressionSelection || draft.candidates.length !== 2 || draft.displayOrder.length !== 2 || draft.centralConsent !== "accepted") throw new EvaluationSubmissionError(400, "incomplete-evaluation", "評価下書きがまだ完成していません。");
  const strokeGroupIds = [...new Set([...draft.drawingAnalysis.parts.flatMap((part) => part.strokeGroupIds), ...draft.candidates.flatMap((candidate) => candidate.lineStrokeMappings?.flatMap((mapping) => mapping.strokeGroupIds) ?? [])])];
  return validateEvaluationSubmission({
    schemaVersion: 1,
    generationId: draft.generationId,
    evaluationReceipt: receipt,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    consentedAt,
    buildId,
    experimentRoundId,
    drawingAnalysisSchemaVersion: draft.drawingAnalysisSchemaVersion,
    lyricsPromptVersion: draft.lyricsPromptVersion,
    firstImpressionSelection: draft.firstImpressionSelection,
    displayOrder: draft.displayOrder,
    candidates: draft.candidates,
    strokeGroupIds,
    drawingAnalysis: draft.drawingAnalysis,
    modelInfo: draft.modelInfo,
    activeCandidateId: draft.activeCandidateId,
    alternativePreviewed: draft.alternativePreviewed,
    centralConsent: "accepted",
  });
};

export const submitEvaluation = async (payload: EvaluationSubmissionPayload): Promise<EvaluationSubmissionResponse> => {
  const body = JSON.stringify(payload);
  if (encoder.encode(body).byteLength > EVALUATION_SUBMISSION_MAX_BYTES) throw new EvaluationSubmissionError(413, "evaluation-too-large", "評価データが大きすぎます。");
  const response = await fetch("/api/evaluations", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const result = await response.json().catch(() => ({})) as Partial<EvaluationSubmissionResponse> & { error?: string; code?: string };
  if (!response.ok) throw new EvaluationSubmissionError(response.status, result.code ?? "evaluation-save-failed", result.error ?? "評価を保存できませんでした。");
  return result as EvaluationSubmissionResponse;
};

export type ExistingEvaluationRow = { generation_id: string; payload_hash: string; status: "pending" | "approved" | "excluded" };
export const saveEvaluationIdempotently = async (database: EvaluationDatabase, payload: EvaluationSubmissionPayload, now = new Date().toISOString()) => {
  const payloadHash = await evaluationPayloadHash(payload);
  const storedJson = JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "evaluationReceipt")));
  const insert = await database.prepare("INSERT INTO evaluation_records (generation_id, payload_hash, created_at, updated_at, status, central_consent, evaluation_json) VALUES (?, ?, ?, ?, 'pending', 'accepted', ?) ON CONFLICT(generation_id) DO NOTHING").bind(payload.generationId, payloadHash, now, now, storedJson).run();
  if ((insert.meta?.changes ?? 0) > 0) return { saved: true as const, duplicate: false as const, payloadHash };
  const existing = await database.prepare("SELECT generation_id, payload_hash, status FROM evaluation_records WHERE generation_id = ?").bind(payload.generationId).first<ExistingEvaluationRow>();
  if (!existing) throw new EvaluationSubmissionError(503, "evaluation-storage-race", "評価を保存できませんでした。");
  if (existing.payload_hash !== payloadHash) throw new EvaluationSubmissionError(409, "evaluation-conflict", "同じ生成結果に異なる評価が届きました。");
  return { saved: true as const, duplicate: true as const, payloadHash };
};
