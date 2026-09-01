/**
 * D1 persistence boundary for the asynchronous VOICEVOX job flow.
 *
 * This deliberately does not enqueue work.  Its only responsibility is to
 * turn the two one-time candidate grants into one all-or-nothing job group.
 * A Queue producer can be added later, after this transaction succeeds.
 */
import {
  DEFAULT_MAX_ATTEMPTS,
  MAX_VOICEVOX_JOB_ATTEMPTS,
  VOICEVOX_JOB_CANDIDATE_IDS,
  type VoicevoxCandidateId,
  type VoicevoxJob,
  type VoicevoxJobGroup,
  type VoicevoxJobStatus,
} from "./voicevoxJobState";

export type VoicevoxJobDatabaseResult<T = unknown> = {
  success: true;
  results: T[];
  meta: { changes?: number; [key: string]: unknown };
};
export type VoicevoxJobPreparedStatement = {
  bind: (...values: unknown[]) => VoicevoxJobPreparedStatement;
  all: <T = unknown>() => Promise<VoicevoxJobDatabaseResult<T>>;
};
export type VoicevoxJobDatabase = {
  prepare: (query: string) => VoicevoxJobPreparedStatement;
  batch: <T = unknown>(statements: VoicevoxJobPreparedStatement[]) => Promise<VoicevoxJobDatabaseResult<T>[]>;
};
type AssertDatabase<T extends VoicevoxJobDatabase> = T;
type CloudflareD1Compatibility = AssertDatabase<D1Database>;

export type VoicevoxJobCandidateRegistration = {
  candidateId: VoicevoxCandidateId;
  jobId: string;
  /** Serialized SingingScore. It is never copied into the queue message. */
  scoreJson: string;
  /** Hash of the exact serialized score. */
  scoreHash: string;
  /** SHA-256 hash of the one-time grant. Raw grants never reach D1. */
  grantHash: string;
};

export type RegisterVoicevoxJobGroupRequest = {
  groupId: string;
  generationId: string;
  candidates: readonly VoicevoxJobCandidateRegistration[];
  now: number;
  expiresAt: number;
  maxAttempts?: number;
};

export type VoicevoxStoredJob = VoicevoxJob & { scoreJson: string; scoreHash: string };
export type VoicevoxJobRegistrationResult = {
  created: boolean;
  group: VoicevoxJobGroup;
  jobs: readonly [VoicevoxStoredJob, VoicevoxStoredJob];
};

export type VoicevoxJobRepositoryErrorCode = "invalid-input" | "grant-invalid" | "idempotency-conflict" | "storage-failed";

export class VoicevoxJobRepositoryError extends Error {
  constructor(public readonly code: VoicevoxJobRepositoryErrorCode, message: string) {
    super(message);
    this.name = "VoicevoxJobRepositoryError";
  }
}

type GroupRow = {
  group_id: string;
  generation_id: string;
  status: VoicevoxJobStatus;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

type JobRow = {
  job_id: string;
  group_id: string;
  generation_id: string;
  candidate_id: VoicevoxCandidateId;
  idempotency_key: string;
  status: VoicevoxJobStatus;
  attempt: number;
  max_attempts: number;
  backend: "vpc" | "cloud-run" | null;
  current_lease_id: string | null;
  result_ref: string | null;
  error_code: string | null;
  error_retryable: 0 | 1 | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  score_json: string;
  score_hash: string;
};

const MAX_ID_LENGTH = 256;
const MAX_SCORE_BYTES = 512 * 1024;
const SHA_256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const isNonEmptyString = (value: unknown, max = MAX_ID_LENGTH): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isSha256Hex = (value: unknown): value is string => typeof value === "string" && SHA_256_HEX_PATTERN.test(value);
const assert: (condition: unknown, code: VoicevoxJobRepositoryErrorCode, message: string) => asserts condition = (condition, code, message) => {
  if (!condition) throw new VoicevoxJobRepositoryError(code, message);
};

const candidatesInOrder = (candidates: readonly VoicevoxJobCandidateRegistration[]) =>
  [...candidates].sort((left, right) => left.candidateId.localeCompare(right.candidateId)) as [VoicevoxJobCandidateRegistration, VoicevoxJobCandidateRegistration];

const snapshotRequest = (request: RegisterVoicevoxJobGroupRequest): RegisterVoicevoxJobGroupRequest => ({
  groupId: request.groupId,
  generationId: request.generationId,
  candidates: request.candidates.map((candidate) => ({ ...candidate })),
  now: request.now,
  expiresAt: request.expiresAt,
  ...(request.maxAttempts === undefined ? {} : { maxAttempts: request.maxAttempts }),
});

const sha256Hex = async (value: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const validateRequest = async (request: RegisterVoicevoxJobGroupRequest) => {
  assert(isNonEmptyString(request.groupId), "invalid-input", "groupId must be a non-empty string");
  assert(isNonEmptyString(request.generationId), "invalid-input", "generationId must be a non-empty string");
  assert(Number.isSafeInteger(request.now), "invalid-input", "now must be an integer timestamp");
  assert(Number.isSafeInteger(request.expiresAt) && request.expiresAt > request.now, "invalid-input", "expiresAt must be later than now");
  const maxAttempts = request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  assert(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= MAX_VOICEVOX_JOB_ATTEMPTS, "invalid-input", "maxAttempts must be between 1 and 5");
  assert(request.candidates.length === VOICEVOX_JOB_CANDIDATE_IDS.length, "invalid-input", "both candidates are required");
  const sorted = candidatesInOrder(request.candidates);
  assert(sorted.every((candidate, index) => candidate.candidateId === VOICEVOX_JOB_CANDIDATE_IDS[index]), "invalid-input", "candidate-a and candidate-b are required exactly once");
  assert(new Set(sorted.map(({ jobId }) => jobId)).size === sorted.length, "invalid-input", "jobId values must be unique");
  for (const candidate of sorted) {
    assert(isNonEmptyString(candidate.jobId), "invalid-input", "jobId must be a non-empty string");
    assert(isSha256Hex(candidate.grantHash), "invalid-input", "grantHash must be a SHA-256 hex digest");
    assert(isSha256Hex(candidate.scoreHash), "invalid-input", "scoreHash must be a SHA-256 hex digest");
    assert(typeof candidate.scoreJson === "string" && candidate.scoreJson.trim().length > 0 && new TextEncoder().encode(candidate.scoreJson).byteLength <= MAX_SCORE_BYTES, "invalid-input", "scoreJson must be a non-empty string within the size limit");
    assert(await sha256Hex(candidate.scoreJson) === candidate.scoreHash, "invalid-input", "scoreHash must match the exact serialized score");
  }
  return { candidates: sorted, maxAttempts };
};

const groupFromRow = (row: GroupRow, jobs: readonly VoicevoxStoredJob[]): VoicevoxJobGroup => ({
  groupId: row.group_id,
  generationId: row.generation_id,
  jobIds: [jobs[0].jobId, jobs[1].jobId],
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
});

const jobFromRow = (row: JobRow): VoicevoxStoredJob => ({
  jobId: row.job_id,
  groupId: row.group_id,
  generationId: row.generation_id,
  candidateId: row.candidate_id,
  idempotencyKey: row.idempotency_key,
  status: row.status,
  attempt: row.attempt,
  maxAttempts: row.max_attempts,
  backend: row.backend,
  leaseId: row.current_lease_id,
  resultRef: row.result_ref,
  failure: row.error_code === null || row.error_retryable === null ? null : { code: row.error_code, retryable: row.error_retryable === 1 },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
  scoreJson: row.score_json,
  scoreHash: row.score_hash,
});

const readExisting = async (database: VoicevoxJobDatabase, generationId: string): Promise<{ group: GroupRow | null; jobs: JobRow[] }> => {
  const [groupResult, jobsResult] = await database.batch([
    database.prepare("/* voicevox-job:group-by-generation */ SELECT group_id, generation_id, status, created_at, updated_at, expires_at FROM voicevox_job_groups WHERE generation_id = ?").bind(generationId),
    database.prepare("/* voicevox-job:jobs-by-generation */ SELECT j.job_id, j.group_id, j.generation_id, j.candidate_id, j.idempotency_key, j.status, j.attempt, j.max_attempts, j.backend, j.current_lease_id, j.result_ref, j.error_code, j.error_retryable, j.created_at, j.updated_at, j.expires_at, p.score_json, p.score_hash FROM voicevox_jobs j LEFT JOIN voicevox_job_payloads p ON p.job_id = j.job_id WHERE j.generation_id = ? ORDER BY j.candidate_id ASC").bind(generationId),
  ]) as [VoicevoxJobDatabaseResult<GroupRow>, VoicevoxJobDatabaseResult<JobRow>];
  return { group: groupResult.results[0] ?? null, jobs: jobsResult.results };
};

const matchesExisting = (existing: { group: GroupRow | null; jobs: JobRow[] }, request: RegisterVoicevoxJobGroupRequest, candidates: readonly VoicevoxJobCandidateRegistration[], maxAttempts: number): VoicevoxJobRegistrationResult | null => {
  if (!existing.group && existing.jobs.length === 0) return null;
  if (!existing.group || existing.jobs.length !== 2) {
    throw new VoicevoxJobRepositoryError("idempotency-conflict", "generation has a partial VOICEVOX job group");
  }
  const jobs = existing.jobs.map(jobFromRow) as [VoicevoxStoredJob, VoicevoxStoredJob];
  const group = existing.group;
  const same = group.group_id === request.groupId && group.generation_id === request.generationId && group.expires_at === request.expiresAt &&
    jobs.every((job, index) => {
      const candidate = candidates[index];
      return job.candidateId === candidate.candidateId && job.jobId === candidate.jobId && job.idempotencyKey === `${request.generationId}:${candidate.candidateId}` &&
        job.groupId === request.groupId && job.generationId === request.generationId && job.maxAttempts === maxAttempts && job.expiresAt === request.expiresAt &&
        job.scoreHash === candidate.scoreHash && job.scoreJson === candidate.scoreJson;
    });
  if (!same) throw new VoicevoxJobRepositoryError("idempotency-conflict", "generation already has different VOICEVOX jobs");
  return { created: false, group: groupFromRow(group, jobs), jobs };
};

const grantIsAvailable = async (database: VoicevoxJobDatabase, request: RegisterVoicevoxJobGroupRequest, candidate: VoicevoxJobCandidateRegistration) => {
  const result = await database.prepare("/* voicevox-job:grant-available */ SELECT grant_hash FROM voicevox_grants WHERE grant_hash = ? AND generation_id = ? AND candidate_id = ? AND issued_at <= ? AND expires_at > ? AND consumed_at IS NULL").bind(candidate.grantHash, request.generationId, candidate.candidateId, request.now, request.now).all<Record<string, unknown>>();
  return result.results.length === 1;
};

const guardedGroupInsert = (request: RegisterVoicevoxJobGroupRequest, candidates: readonly VoicevoxJobCandidateRegistration[]) => {
  // D1 batch rolls back on statement errors, but an UPDATE that changes zero
  // rows is not an error. This statement must be first: it checks both grants
  // while they are still unconsumed, then deliberately violates the status
  // CHECK when either is invalid. That prevents a same-millisecond prior
  // consumption from being mistaken for this registration's own UPDATE.
  const grantPredicate = candidates.map(() => "(SELECT COUNT(*) FROM voicevox_grants WHERE grant_hash = ? AND generation_id = ? AND candidate_id = ? AND issued_at <= ? AND expires_at > ? AND consumed_at IS NULL) = 1").join(" AND ");
  const predicateValues = candidates.flatMap((candidate) => [candidate.grantHash, request.generationId, candidate.candidateId, request.now, request.now]);
  return {
    query: `/* voicevox-job:guarded-group-insert */ INSERT INTO voicevox_job_groups (group_id, generation_id, status, created_at, updated_at, expires_at) SELECT ?, ?, CASE WHEN ${grantPredicate} THEN 'accepted' ELSE 'invalid-grant-state' END, ?, ?, ?`,
    values: [request.groupId, request.generationId, ...predicateValues, request.now, request.now, request.expiresAt],
  };
};

const insertJobStatement = (request: RegisterVoicevoxJobGroupRequest, candidate: VoicevoxJobCandidateRegistration, maxAttempts: number) =>
  databaseStatement(
    "/* voicevox-job:insert-job */ INSERT INTO voicevox_jobs (job_id, group_id, generation_id, candidate_id, idempotency_key, status, attempt, max_attempts, backend, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, 'accepted', 0, ?, NULL, ?, ?, ?) ON CONFLICT(generation_id, candidate_id) DO UPDATE SET attempt = CASE WHEN voicevox_jobs.job_id = excluded.job_id AND voicevox_jobs.group_id = excluded.group_id AND voicevox_jobs.generation_id = excluded.generation_id AND voicevox_jobs.candidate_id = excluded.candidate_id AND voicevox_jobs.idempotency_key = excluded.idempotency_key AND voicevox_jobs.max_attempts = excluded.max_attempts AND voicevox_jobs.expires_at = excluded.expires_at THEN voicevox_jobs.attempt ELSE -1 END",
    [candidate.jobId, request.groupId, request.generationId, candidate.candidateId, `${request.generationId}:${candidate.candidateId}`, maxAttempts, request.now, request.now, request.expiresAt],
  );

const insertPayloadStatement = (request: RegisterVoicevoxJobGroupRequest, candidate: VoicevoxJobCandidateRegistration) =>
  databaseStatement(
    "/* voicevox-job:insert-payload */ INSERT INTO voicevox_job_payloads (job_id, score_json, score_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET score_hash = CASE WHEN voicevox_job_payloads.score_hash = excluded.score_hash AND voicevox_job_payloads.score_json = excluded.score_json AND voicevox_job_payloads.expires_at = excluded.expires_at THEN voicevox_job_payloads.score_hash ELSE '' END",
    [candidate.jobId, candidate.scoreJson, candidate.scoreHash, request.now, request.expiresAt],
  );

const databaseStatement = (query: string, values: readonly unknown[]) => ({ query, values });

/**
 * Atomically consumes the two candidate grants and creates both jobs.
 *
 * A matching generation is returned before grants are read, which makes a
 * browser retry safe even though the original one-time grants are consumed.
 */
export const registerVoicevoxJobs = async (database: VoicevoxJobDatabase, request: RegisterVoicevoxJobGroupRequest): Promise<VoicevoxJobRegistrationResult> => {
  const snapshot = snapshotRequest(request);
  const { candidates, maxAttempts } = await validateRequest(snapshot);
  const existing = matchesExisting(await readExisting(database, snapshot.generationId), snapshot, candidates, maxAttempts);
  if (existing) return existing;

  const grantsAvailable = await Promise.all(candidates.map((candidate) => grantIsAvailable(database, snapshot, candidate)));
  if (!grantsAvailable.every(Boolean)) throw new VoicevoxJobRepositoryError("grant-invalid", "one or more voice grants are invalid or expired");

  const groupStatement = guardedGroupInsert(snapshot, candidates);
  const statements: VoicevoxJobPreparedStatement[] = [
    database.prepare(groupStatement.query).bind(...groupStatement.values),
    ...candidates.map((candidate) => database.prepare("/* voicevox-job:consume-grant */ UPDATE voicevox_grants SET consumed_at = ?, score_hash = ? WHERE grant_hash = ? AND generation_id = ? AND candidate_id = ? AND issued_at <= ? AND expires_at > ? AND consumed_at IS NULL").bind(snapshot.now, candidate.scoreHash, candidate.grantHash, snapshot.generationId, candidate.candidateId, snapshot.now, snapshot.now)),
    ...candidates.map((candidate) => {
      const statement = insertJobStatement(snapshot, candidate, maxAttempts);
      return database.prepare(statement.query).bind(...statement.values);
    }),
    ...candidates.map((candidate) => {
      const statement = insertPayloadStatement(snapshot, candidate);
      return database.prepare(statement.query).bind(...statement.values);
    }),
  ];

  try {
    await database.batch(statements);
  } catch (error) {
    // A concurrent identical request can win after the initial read. Treat it
    // as a retry only when every persisted field matches; all other partial or
    // divergent states remain a conflict.
    const afterFailure = matchesExisting(await readExisting(database, snapshot.generationId), snapshot, candidates, maxAttempts);
    if (afterFailure) return afterFailure;
    const availableAfterFailure = await Promise.all(candidates.map((candidate) => grantIsAvailable(database, snapshot, candidate)));
    if (!availableAfterFailure.every(Boolean)) throw new VoicevoxJobRepositoryError("grant-invalid", "one or more voice grants are invalid or expired");
    throw new VoicevoxJobRepositoryError("storage-failed", error instanceof Error ? error.message : "VOICEVOX jobs could not be stored");
  }
  const stored = matchesExisting(await readExisting(database, snapshot.generationId), snapshot, candidates, maxAttempts);
  if (!stored) throw new VoicevoxJobRepositoryError("storage-failed", "VOICEVOX job batch completed without a job group");
  return { ...stored, created: true };
};
