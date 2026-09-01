/**
 * Conditional D1 transitions for asynchronous VOICEVOX jobs.
 *
 * Queue delivery is at-least-once. Every consumer transition therefore fences
 * on both the opaque lease id and its attempt number; duplicate messages and
 * stale consumers can observe state but cannot overwrite newer work.
 */
import type {
  VoicevoxJobDatabase,
  VoicevoxJobDatabaseResult,
  VoicevoxJobPreparedStatement,
} from "./voicevoxJobRepository";
import type {
  VoicevoxBackend,
  VoicevoxCandidateId,
  VoicevoxJobStatus,
} from "./voicevoxJobState";

export type VoicevoxLifecycleErrorCode = "invalid-input" | "storage-failed";
export class VoicevoxLifecycleError extends Error {
  constructor(
    public readonly code: VoicevoxLifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VoicevoxLifecycleError";
  }
}

export type VoicevoxLifecycleOutcome =
  | "applied"
  | "duplicate"
  | "stale-consumer"
  | "not-claimable"
  | "expired"
  | "not-found";
export type VoicevoxLifecycleJob = {
  jobId: string;
  groupId: string;
  generationId: string;
  candidateId: VoicevoxCandidateId;
  status: VoicevoxJobStatus;
  attempt: number;
  maxAttempts: number;
  backend: VoicevoxBackend | null;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  resultRef: string | null;
  errorCode: string | null;
  errorRetryable: boolean | null;
  dispatchedAt: number | null;
  dispatchLeaseId: string | null;
  dispatchLeaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};
export type VoicevoxLifecycleGroup = {
  groupId: string;
  generationId: string;
  status: VoicevoxJobStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};
export type VoicevoxLifecycleResult = {
  outcome: VoicevoxLifecycleOutcome;
  job: VoicevoxLifecycleJob | null;
  group: VoicevoxLifecycleGroup | null;
};
export type ClaimVoicevoxJobInput = {
  jobId: string;
  leaseId: string;
  attempt: number;
  backend: VoicevoxBackend;
  now: number;
  leaseExpiresAt: number;
};
export type CompleteVoicevoxJobInput = {
  jobId: string;
  leaseId: string;
  attempt: number;
  resultRef: string;
  resultExpiresAt: number;
  now: number;
};
export type FailVoicevoxJobInput = {
  jobId: string;
  leaseId: string;
  attempt: number;
  errorCode: string;
  retryable: boolean;
  now: number;
};
export type CancelVoicevoxJobInput = { jobId: string; now: number };
export type DispatchLeaseInput = {
  jobId: string;
  dispatchLeaseId: string;
  now: number;
  leaseExpiresAt: number;
  staleAfterMs?: number;
};

type JobRow = {
  job_id: string;
  group_id: string;
  generation_id: string;
  candidate_id: VoicevoxCandidateId;
  status: VoicevoxJobStatus;
  attempt: number;
  max_attempts: number;
  backend: VoicevoxBackend | null;
  current_lease_id: string | null;
  current_lease_expires_at: number | null;
  result_ref: string | null;
  error_code: string | null;
  error_retryable: 0 | 1 | null;
  dispatch_lease_id: string | null;
  dispatch_lease_expires_at: number | null;
  dispatched_at: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
};
type GroupRow = {
  group_id: string;
  generation_id: string;
  status: VoicevoxJobStatus;
  created_at: number;
  updated_at: number;
  expires_at: number;
};
const maxText = 256;
const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new VoicevoxLifecycleError("invalid-input", message);
};
const id = (value: unknown, field: string) =>
  assert(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= maxText,
    `${field} must be a non-empty string`,
  );
const timestamp = (value: unknown, field: string) =>
  assert(
    Number.isSafeInteger(value) && (value as number) >= 0,
    `${field} must be a non-negative integer timestamp`,
  );
const attempt = (value: unknown) =>
  assert(
    Number.isInteger(value) && (value as number) >= 1,
    "attempt must be a positive integer",
  );
const statement = (
  database: VoicevoxJobDatabase,
  query: string,
  values: readonly unknown[],
) => database.prepare(query).bind(...values);
const jobColumns =
  "job_id, group_id, generation_id, candidate_id, status, attempt, max_attempts, backend, current_lease_id, current_lease_expires_at, result_ref, error_code, error_retryable, dispatch_lease_id, dispatch_lease_expires_at, dispatched_at, created_at, updated_at, expires_at";
const jobSelect = `SELECT ${jobColumns} FROM voicevox_jobs WHERE job_id = ?`;
const groupSelect =
  "SELECT group_id, generation_id, status, created_at, updated_at, expires_at FROM voicevox_job_groups WHERE group_id = ?";
const groupStatusUpdate = () =>
  `/* voicevox-lifecycle:refresh-group */ UPDATE voicevox_job_groups SET status = CASE
    WHEN NOT EXISTS (SELECT 1 FROM voicevox_jobs j WHERE j.group_id = voicevox_job_groups.group_id AND j.status <> 'succeeded') THEN 'succeeded'
    WHEN NOT EXISTS (SELECT 1 FROM voicevox_jobs j WHERE j.group_id = voicevox_job_groups.group_id AND j.status NOT IN ('succeeded', 'failed', 'cancelled')) THEN CASE WHEN EXISTS (SELECT 1 FROM voicevox_jobs j WHERE j.group_id = voicevox_job_groups.group_id AND j.status = 'failed') THEN 'failed' ELSE 'cancelled' END
    WHEN EXISTS (SELECT 1 FROM voicevox_jobs j WHERE j.group_id = voicevox_job_groups.group_id AND j.status = 'running') THEN 'running'
    WHEN EXISTS (SELECT 1 FROM voicevox_jobs j WHERE j.group_id = voicevox_job_groups.group_id AND j.status = 'queued') THEN 'queued'
    ELSE 'accepted' END, updated_at = MAX(updated_at, ?) WHERE group_id = (SELECT group_id FROM voicevox_jobs WHERE job_id = ?) AND EXISTS (SELECT 1 FROM voicevox_jobs WHERE job_id = ? AND updated_at = ?)`;
const toJob = (row: JobRow): VoicevoxLifecycleJob => ({
  jobId: row.job_id,
  groupId: row.group_id,
  generationId: row.generation_id,
  candidateId: row.candidate_id,
  status: row.status,
  attempt: row.attempt,
  maxAttempts: row.max_attempts,
  backend: row.backend,
  leaseId: row.current_lease_id,
  leaseExpiresAt: row.current_lease_expires_at,
  resultRef: row.result_ref,
  errorCode: row.error_code,
  errorRetryable:
    row.error_retryable === null ? null : row.error_retryable === 1,
  dispatchLeaseId: row.dispatch_lease_id,
  dispatchLeaseExpiresAt: row.dispatch_lease_expires_at,
  dispatchedAt: row.dispatched_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
});
const toGroup = (row: GroupRow): VoicevoxLifecycleGroup => ({
  groupId: row.group_id,
  generationId: row.generation_id,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
});

const read = async (
  database: VoicevoxJobDatabase,
  jobId: string,
): Promise<{ job: JobRow | null; group: GroupRow | null }> => {
  const [jobResult, groupResult] = (await database.batch([
    statement(database, `/* voicevox-lifecycle:read-job */ ${jobSelect}`, [
      jobId,
    ]),
    statement(
      database,
      `/* voicevox-lifecycle:read-group */ SELECT group_id, generation_id, status, created_at, updated_at, expires_at FROM voicevox_job_groups WHERE group_id = (SELECT group_id FROM voicevox_jobs WHERE job_id = ?)`,
      [jobId],
    ),
  ])) as [
    VoicevoxJobDatabaseResult<JobRow>,
    VoicevoxJobDatabaseResult<GroupRow>,
  ];
  const job = jobResult.results[0] ?? null;
  if (!job) return { job: null, group: null };
  return { job, group: groupResult.results[0] ?? null };
};
const result = async (
  database: VoicevoxJobDatabase,
  jobId: string,
  now: number,
  fallback: VoicevoxLifecycleOutcome,
): Promise<VoicevoxLifecycleResult> => {
  const snapshot = await read(database, jobId);
  if (!snapshot.job) return { outcome: "not-found", job: null, group: null };
  const job = toJob(snapshot.job);
  const outcome =
    job.expiresAt <= now &&
    !["succeeded", "failed", "cancelled"].includes(job.status)
      ? "expired"
      : fallback;
  return {
    outcome,
    job,
    group: snapshot.group ? toGroup(snapshot.group) : null,
  };
};
const mutate = async (
  database: VoicevoxJobDatabase,
  jobId: string,
  now: number,
  update: VoicevoxJobPreparedStatement,
) => {
  try {
    const [updated] = await database.batch([
      update,
      statement(database, groupStatusUpdate(), [now, jobId, jobId, now]),
    ]);
    return updated.meta.changes ?? 0;
  } catch (error) {
    throw new VoicevoxLifecycleError(
      "storage-failed",
      error instanceof Error
        ? error.message
        : "VOICEVOX lifecycle update failed",
    );
  }
};

export const claimVoicevoxJob = async (
  database: VoicevoxJobDatabase,
  input: ClaimVoicevoxJobInput,
): Promise<VoicevoxLifecycleResult> => {
  id(input.jobId, "jobId");
  id(input.leaseId, "leaseId");
  attempt(input.attempt);
  timestamp(input.now, "now");
  timestamp(input.leaseExpiresAt, "leaseExpiresAt");
  assert(
    input.leaseExpiresAt > input.now,
    "leaseExpiresAt must be later than now",
  );
  assert(
    input.backend === "vpc" || input.backend === "cloud-run",
    "backend must be vpc or cloud-run",
  );
  const update = statement(
    database,
    `/* voicevox-lifecycle:claim */ UPDATE voicevox_jobs SET status='running', attempt=attempt + 1, backend=?, current_lease_id=?, current_lease_expires_at=MIN(?, expires_at), dispatch_lease_id=NULL, dispatch_lease_expires_at=NULL, error_code=NULL, error_retryable=NULL, updated_at=? WHERE job_id=? AND status IN ('accepted','queued') AND expires_at > ? AND attempt + 1 = ? AND attempt < max_attempts AND updated_at <= ?`,
    [
      input.backend,
      input.leaseId,
      input.leaseExpiresAt,
      input.now,
      input.jobId,
      input.now,
      input.attempt,
      input.now,
    ],
  );
  const changes = await mutate(database, input.jobId, input.now, update);
  const after = await read(database, input.jobId);
  if (!after.job) return { outcome: "not-found", job: null, group: null };
  const job = toJob(after.job);
  if (
    job.status === "running" &&
    job.leaseId === input.leaseId &&
    job.attempt === input.attempt &&
    job.backend === input.backend
  )
    return {
      outcome: changes ? "applied" : "duplicate",
      job,
      group: after.group ? toGroup(after.group) : null,
    };
  return {
    outcome: job.expiresAt <= input.now ? "expired" : "not-claimable",
    job,
    group: after.group ? toGroup(after.group) : null,
  };
};

export const completeVoicevoxJob = async (
  database: VoicevoxJobDatabase,
  input: CompleteVoicevoxJobInput,
): Promise<VoicevoxLifecycleResult> => {
  id(input.jobId, "jobId");
  id(input.leaseId, "leaseId");
  id(input.resultRef, "resultRef");
  attempt(input.attempt);
  timestamp(input.now, "now");
  timestamp(input.resultExpiresAt, "resultExpiresAt");
  assert(
    input.resultExpiresAt > input.now,
    "resultExpiresAt must be later than now",
  );
  const update = statement(
    database,
    `/* voicevox-lifecycle:complete */ UPDATE voicevox_jobs SET status='succeeded', result_ref=?, result_expires_at=MIN(?, expires_at), current_lease_id=NULL, current_lease_expires_at=NULL, error_code=NULL, error_retryable=NULL, updated_at=? WHERE job_id=? AND status='running' AND current_lease_id=? AND attempt=? AND current_lease_expires_at > ? AND expires_at > ? AND updated_at <= ?`,
    [
      input.resultRef,
      input.resultExpiresAt,
      input.now,
      input.jobId,
      input.leaseId,
      input.attempt,
      input.now,
      input.now,
      input.now,
    ],
  );
  const changes = await mutate(database, input.jobId, input.now, update);
  const after = await read(database, input.jobId);
  if (!after.job) return { outcome: "not-found", job: null, group: null };
  const job = toJob(after.job);
  if (job.status === "succeeded" && job.resultRef === input.resultRef)
    return {
      outcome: changes ? "applied" : "duplicate",
      job,
      group: after.group ? toGroup(after.group) : null,
    };
  return {
    outcome: job.expiresAt <= input.now ? "expired" : "stale-consumer",
    job,
    group: after.group ? toGroup(after.group) : null,
  };
};

export const failVoicevoxJob = async (
  database: VoicevoxJobDatabase,
  input: FailVoicevoxJobInput,
): Promise<VoicevoxLifecycleResult> => {
  id(input.jobId, "jobId");
  id(input.leaseId, "leaseId");
  id(input.errorCode, "errorCode");
  assert(
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(input.errorCode),
    "errorCode must be a stable lowercase code",
  );
  attempt(input.attempt);
  timestamp(input.now, "now");
  assert(typeof input.retryable === "boolean", "retryable must be a boolean");
  const update = statement(
    database,
    `/* voicevox-lifecycle:fail */ UPDATE voicevox_jobs SET status=CASE WHEN ? = 1 AND attempt < max_attempts THEN 'queued' ELSE 'failed' END, current_lease_id=NULL, current_lease_expires_at=NULL, dispatch_lease_id=NULL, dispatch_lease_expires_at=NULL, dispatched_at=CASE WHEN ? = 1 AND attempt < max_attempts THEN NULL ELSE dispatched_at END, error_code=?, error_retryable=?, updated_at=? WHERE job_id=? AND status='running' AND current_lease_id=? AND attempt=? AND current_lease_expires_at > ? AND expires_at > ? AND updated_at <= ?`,
    [
      input.retryable ? 1 : 0,
      input.retryable ? 1 : 0,
      input.errorCode,
      input.retryable ? 1 : 0,
      input.now,
      input.jobId,
      input.leaseId,
      input.attempt,
      input.now,
      input.now,
      input.now,
    ],
  );
  const changes = await mutate(database, input.jobId, input.now, update);
  const after = await read(database, input.jobId);
  if (!after.job) return { outcome: "not-found", job: null, group: null };
  const job = toJob(after.job);
  if (
    (job.status === "queued" || job.status === "failed") &&
    job.errorCode === input.errorCode &&
    job.attempt === input.attempt &&
    job.leaseId === null
  )
    return {
      outcome: changes ? "applied" : "duplicate",
      job,
      group: after.group ? toGroup(after.group) : null,
    };
  return {
    outcome: job.expiresAt <= input.now ? "expired" : "stale-consumer",
    job,
    group: after.group ? toGroup(after.group) : null,
  };
};

export const cancelVoicevoxJob = async (
  database: VoicevoxJobDatabase,
  input: CancelVoicevoxJobInput,
): Promise<VoicevoxLifecycleResult> => {
  id(input.jobId, "jobId");
  timestamp(input.now, "now");
  const update = statement(
    database,
    `/* voicevox-lifecycle:cancel */ UPDATE voicevox_jobs SET status='cancelled', current_lease_id=NULL, current_lease_expires_at=NULL, dispatch_lease_id=NULL, dispatch_lease_expires_at=NULL, error_code='cancelled', error_retryable=0, updated_at=? WHERE job_id=? AND status IN ('accepted','queued','running') AND updated_at <= ? AND expires_at > ?`,
    [input.now, input.jobId, input.now, input.now],
  );
  const changes = await mutate(database, input.jobId, input.now, update);
  const after = await read(database, input.jobId);
  if (!after.job) return { outcome: "not-found", job: null, group: null };
  return {
    outcome: changes ? "applied" : after.job.expires_at <= input.now ? "expired" : "duplicate",
    job: toJob(after.job),
    group: after.group ? toGroup(after.group) : null,
  };
};

export const recoverExpiredVoicevoxJobs = async (
  database: VoicevoxJobDatabase,
  input: { now: number; limit?: number },
): Promise<readonly VoicevoxLifecycleResult[]> => {
  timestamp(input.now, "now");
  const limit = input.limit ?? 100;
  assert(
    Number.isInteger(limit) && limit >= 1 && limit <= 100,
    "limit must be between 1 and 100",
  );
  const candidates = await database
    .prepare(
      `/* voicevox-lifecycle:expired-candidates */ SELECT ${jobColumns} FROM voicevox_jobs WHERE (status='running' AND (current_lease_expires_at <= ? OR expires_at <= ?)) OR (status IN ('accepted','queued') AND expires_at <= ?) ORDER BY updated_at ASC LIMIT ?`,
    )
    .bind(input.now, input.now, input.now, limit)
    .all<JobRow>();
  const results: VoicevoxLifecycleResult[] = [];
  for (const { job_id: jobId } of candidates.results) {
    const update = statement(
      database,
      `/* voicevox-lifecycle:recover-expired */ UPDATE voicevox_jobs SET status=CASE WHEN expires_at <= ? OR attempt >= max_attempts THEN 'failed' ELSE 'queued' END, current_lease_id=NULL, current_lease_expires_at=NULL, dispatch_lease_id=NULL, dispatch_lease_expires_at=NULL, dispatched_at=CASE WHEN expires_at <= ? THEN dispatched_at ELSE NULL END, error_code=CASE WHEN expires_at <= ? THEN 'job-expired' ELSE 'lease-expired' END, error_retryable=CASE WHEN expires_at <= ? OR attempt >= max_attempts THEN 0 ELSE 1 END, updated_at=? WHERE job_id=? AND ((status='running' AND (current_lease_expires_at <= ? OR expires_at <= ?)) OR (status IN ('accepted','queued') AND expires_at <= ?)) AND updated_at <= ?`,
      [
        input.now,
        input.now,
        input.now,
        input.now,
        input.now,
        jobId,
        input.now,
        input.now,
        input.now,
        input.now,
      ],
    );
    const changes = await mutate(database, jobId, input.now, update);
    const after = await result(
      database,
      jobId,
      input.now,
      changes ? "applied" : "duplicate",
    );
    results.push(after);
  }
  return results;
};

export const claimVoicevoxJobDispatch = async (
  database: VoicevoxJobDatabase,
  input: DispatchLeaseInput,
): Promise<VoicevoxLifecycleResult> => {
  id(input.jobId, "jobId");
  id(input.dispatchLeaseId, "dispatchLeaseId");
  timestamp(input.now, "now");
  timestamp(input.leaseExpiresAt, "leaseExpiresAt");
  assert(
    input.leaseExpiresAt > input.now,
    "leaseExpiresAt must be later than now",
  );
  const staleAfterMs = input.staleAfterMs ?? 300_000;
  assert(
    Number.isSafeInteger(staleAfterMs) && staleAfterMs >= 0,
    "staleAfterMs must be a non-negative integer",
  );
  // Recheck eligibility inside the write: another dispatcher may have sent and
  // marked the row since our earlier list, releasing its dispatch lease.
  const update = statement(
    database,
    `/* voicevox-lifecycle:claim-dispatch */ UPDATE voicevox_jobs SET dispatch_lease_id=?, dispatch_lease_expires_at=MIN(?, expires_at), updated_at=? WHERE job_id=? AND status IN ('accepted','queued') AND expires_at > ? AND (dispatch_lease_id IS NULL OR dispatch_lease_expires_at <= ?) AND updated_at <= ? AND (status='accepted' OR dispatched_at IS NULL OR dispatched_at <= ?)`,
    [
      input.dispatchLeaseId,
      input.leaseExpiresAt,
      input.now,
      input.jobId,
      input.now,
      input.now,
      input.now,
      input.now - staleAfterMs,
    ],
  );
  const changes = await mutate(database, input.jobId, input.now, update);
  const after = await read(database, input.jobId);
  if (!after.job) return { outcome: "not-found", job: null, group: null };
  const job = toJob(after.job);
  return {
    outcome:
      job.dispatchLeaseId === input.dispatchLeaseId
        ? changes
          ? "applied"
          : "duplicate"
        : job.expiresAt <= input.now
          ? "expired"
          : "not-claimable",
    job,
    group: after.group ? toGroup(after.group) : null,
  };
};

/** Call only after Queue.send succeeds. A crash before this call leaves work redispatchable. */
export const markVoicevoxJobDispatched = async (
  database: VoicevoxJobDatabase,
  input: { jobId: string; dispatchLeaseId: string; now: number },
): Promise<VoicevoxLifecycleResult> => {
  id(input.jobId, "jobId");
  id(input.dispatchLeaseId, "dispatchLeaseId");
  timestamp(input.now, "now");
  const update = statement(
    database,
    `/* voicevox-lifecycle:mark-dispatched */ UPDATE voicevox_jobs SET status='queued', dispatched_at=?, dispatch_lease_id=NULL, dispatch_lease_expires_at=NULL, updated_at=? WHERE job_id=? AND status IN ('accepted','queued') AND dispatch_lease_id=? AND dispatch_lease_expires_at > ? AND expires_at > ? AND updated_at <= ?`,
    [
      input.now,
      input.now,
      input.jobId,
      input.dispatchLeaseId,
      input.now,
      input.now,
      input.now,
    ],
  );
  const changes = await mutate(database, input.jobId, input.now, update);
  const after = await read(database, input.jobId);
  if (!after.job) return { outcome: "not-found", job: null, group: null };
  const job = toJob(after.job);
  return {
    outcome:
      job.status === "queued" &&
      job.dispatchedAt === input.now &&
      job.dispatchLeaseId === null
        ? changes
          ? "applied"
          : "duplicate"
        : job.expiresAt <= input.now
          ? "expired"
          : "stale-consumer",
    job,
    group: after.group ? toGroup(after.group) : null,
  };
};

/** Accepted jobs and queued jobs whose delivery lease/visibility has gone stale form the durable outbox. */
export const listVoicevoxRedispatchableJobs = async (
  database: VoicevoxJobDatabase,
  input: { now: number; staleAfterMs: number; limit: number },
): Promise<readonly VoicevoxLifecycleJob[]> => {
  timestamp(input.now, "now");
  assert(
    Number.isSafeInteger(input.staleAfterMs) && input.staleAfterMs >= 0,
    "staleAfterMs must be a non-negative integer",
  );
  assert(
    Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 100,
    "limit must be between 1 and 100",
  );
  const threshold = input.now - input.staleAfterMs;
  const rows = await database
    .prepare(
      `/* voicevox-lifecycle:redispatchable */ SELECT ${jobColumns} FROM voicevox_jobs WHERE status IN ('accepted','queued') AND expires_at > ? AND (dispatch_lease_id IS NULL OR dispatch_lease_expires_at <= ?) AND (status='accepted' OR dispatched_at IS NULL OR dispatched_at <= ?) ORDER BY updated_at ASC, job_id ASC LIMIT ?`,
    )
    .bind(input.now, input.now, threshold, input.limit)
    .all<JobRow>();
  return rows.results.map(toJob);
};

/** Privacy retention: remove only expired serialized scores. Job/result metadata remains for later R2 cleanup and idempotency. */
export const purgeExpiredVoicevoxJobPayloads = async (
  database: VoicevoxJobDatabase,
  input: { now: number; limit?: number },
): Promise<number> => {
  timestamp(input.now, "now");
  const limit = input.limit ?? 100;
  assert(
    Number.isInteger(limit) && limit >= 1 && limit <= 100,
    "limit must be between 1 and 100",
  );
  try {
    const [deleted] = await database.batch([
      statement(
        database,
        "/* voicevox-lifecycle:purge-expired-payloads */ DELETE FROM voicevox_job_payloads WHERE job_id IN (SELECT job_id FROM voicevox_job_payloads WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?)",
        [input.now, limit],
      ),
    ]);
    return deleted.meta.changes ?? 0;
  } catch (error) {
    throw new VoicevoxLifecycleError(
      "storage-failed",
      error instanceof Error
        ? error.message
        : "VOICEVOX payload cleanup failed",
    );
  }
};
