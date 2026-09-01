/**
 * Pure state machine for the asynchronous VOICEVOX job flow.
 *
 * This module deliberately has no Cloudflare, database, queue, or runtime
 * dependencies.  Persistence and delivery adapters can serialize the state
 * and apply these functions atomically in a later phase.
 */

export const VOICEVOX_JOB_CANDIDATE_IDS = ["candidate-a", "candidate-b"] as const;
export type VoicevoxCandidateId = (typeof VOICEVOX_JOB_CANDIDATE_IDS)[number];

export const VOICEVOX_JOB_STATUSES = [
  "accepted",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type VoicevoxJobStatus = (typeof VOICEVOX_JOB_STATUSES)[number];
export type VoicevoxBackend = "vpc" | "cloud-run";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const MAX_VOICEVOX_JOB_ATTEMPTS = 5;
// Worker-side VOICEVOX allows up to 45 seconds for the query and 120 seconds
// for synthesis. Leave room for Cloud Run startup and result persistence.
export const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;

export type VoicevoxJobFailure = {
  code: string;
  retryable: boolean;
};

export type VoicevoxJob = {
  jobId: string;
  groupId: string;
  generationId: string;
  candidateId: VoicevoxCandidateId;
  idempotencyKey: string;
  payloadRef?: string;
  status: VoicevoxJobStatus;
  attempt: number;
  maxAttempts: number;
  backend: VoicevoxBackend | null;
  leaseId: string | null;
  resultRef: string | null;
  failure: VoicevoxJobFailure | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type VoicevoxJobGroup = {
  groupId: string;
  generationId: string;
  jobIds: readonly [string, string];
  status: VoicevoxJobStatus;
  /** Backend fixed for both candidates when the generation is admitted. */
  preferredBackend?: VoicevoxBackend;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type VoicevoxJobLease = {
  leaseId: string;
  jobId: string;
  backend: VoicevoxBackend;
  attempt: number;
  acquiredAt: number;
  expiresAt: number;
};

export type VoicevoxJobState = {
  groups: Readonly<Record<string, VoicevoxJobGroup>>;
  jobs: Readonly<Record<string, VoicevoxJob>>;
  leases: Readonly<Record<string, VoicevoxJobLease>>;
};

export type VoicevoxJobCandidateInput = {
  candidateId: VoicevoxCandidateId;
  jobId: string;
  payloadRef?: string;
};

export type RegisterVoicevoxJobGroupInput = {
  groupId: string;
  generationId: string;
  candidates: readonly VoicevoxJobCandidateInput[];
  now: number;
  expiresAt: number;
  maxAttempts?: number;
};

export type VoicevoxJobStateErrorCode =
  | "invalid-input"
  | "duplicate-idempotency-key"
  | "idempotency-conflict"
  | "unknown-job"
  | "unknown-group"
  | "invalid-transition"
  | "lease-already-held"
  | "lease-not-found"
  | "lease-mismatch"
  | "attempt-limit"
  | "job-expired";

export class VoicevoxJobStateError extends Error {
  readonly code: VoicevoxJobStateErrorCode;

  constructor(code: VoicevoxJobStateErrorCode, message: string) {
    super(message);
    this.name = "VoicevoxJobStateError";
    this.code = code;
  }
}

const TERMINAL_STATUSES = new Set<VoicevoxJobStatus>(["succeeded", "failed", "cancelled"]);

const assertNonEmpty = (value: string, field: string) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new VoicevoxJobStateError("invalid-input", `${field} must be a non-empty string`);
  }
};

const assertNow = (now: number) => {
  if (!Number.isFinite(now)) {
    throw new VoicevoxJobStateError("invalid-input", "now must be a finite number");
  }
};

export const createVoicevoxJobState = (): VoicevoxJobState => ({
  groups: {},
  jobs: {},
  leases: {},
});

export const createVoicevoxJobIdempotencyKey = (generationId: string, candidateId: VoicevoxCandidateId) => {
  assertNonEmpty(generationId, "generationId");
  if (!VOICEVOX_JOB_CANDIDATE_IDS.includes(candidateId)) {
    throw new VoicevoxJobStateError("invalid-input", `unsupported candidateId: ${candidateId}`);
  }
  return `${generationId}:${candidateId}`;
};

const validateRegistrationInput = (input: RegisterVoicevoxJobGroupInput) => {
  assertNonEmpty(input.groupId, "groupId");
  assertNonEmpty(input.generationId, "generationId");
  assertNow(input.now);
  assertNow(input.expiresAt);
  if (input.expiresAt <= input.now) {
    throw new VoicevoxJobStateError("invalid-input", "expiresAt must be later than now");
  }
  if (!Number.isInteger(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) || (input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) < 1 || (input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) > MAX_VOICEVOX_JOB_ATTEMPTS) {
    throw new VoicevoxJobStateError("invalid-input", "maxAttempts must be between 1 and 5");
  }
  if (input.candidates.length !== VOICEVOX_JOB_CANDIDATE_IDS.length) {
    throw new VoicevoxJobStateError("invalid-input", "a job group must contain exactly candidate-a and candidate-b");
  }
  const ids = input.candidates.map(({ candidateId }) => candidateId);
  if (new Set(ids).size !== VOICEVOX_JOB_CANDIDATE_IDS.length || VOICEVOX_JOB_CANDIDATE_IDS.some((id) => !ids.includes(id))) {
    throw new VoicevoxJobStateError("invalid-input", "a job group must contain candidate-a and candidate-b exactly once");
  }
  const jobIds = input.candidates.map(({ jobId }) => jobId);
  for (const jobId of jobIds) assertNonEmpty(jobId, "jobId");
  if (new Set(jobIds).size !== jobIds.length) {
    throw new VoicevoxJobStateError("invalid-input", "jobId values must be unique");
  }
};

const groupStatusFromJobs = (jobs: readonly VoicevoxJob[]): VoicevoxJobStatus => {
  if (jobs.every(({ status }) => status === "succeeded")) return "succeeded";
  if (jobs.every(({ status }) => TERMINAL_STATUSES.has(status))) {
    return jobs.some(({ status }) => status === "failed") ? "failed" : "cancelled";
  }
  if (jobs.some(({ status }) => status === "running")) return "running";
  if (jobs.some(({ status }) => status === "queued")) return "queued";
  return "accepted";
};

const withJob = (state: VoicevoxJobState, job: VoicevoxJob, now: number, leases = state.leases): VoicevoxJobState => {
  const jobs = { ...state.jobs, [job.jobId]: job };
  const group = state.groups[job.groupId];
  if (!group) throw new VoicevoxJobStateError("unknown-group", `unknown group: ${job.groupId}`);
  const groupJobs = group.jobIds.map((jobId) => jobs[jobId]);
  const groups = {
    ...state.groups,
    [group.groupId]: {
      ...group,
      status: groupStatusFromJobs(groupJobs),
      updatedAt: now,
    },
  };
  return { groups, jobs, leases };
};

const getJob = (state: VoicevoxJobState, jobId: string) => {
  const job = state.jobs[jobId];
  if (!job) throw new VoicevoxJobStateError("unknown-job", `unknown job: ${jobId}`);
  return job;
};

const assertJobNotExpired = (job: VoicevoxJob, now: number) => {
  if (job.expiresAt <= now) {
    throw new VoicevoxJobStateError("job-expired", `job has expired: ${job.jobId}`);
  }
};

const isSameCandidate = (job: VoicevoxJob, candidate: VoicevoxJobCandidateInput, groupId: string, generationId: string, maxAttempts: number, expiresAt: number) =>
  job.groupId === groupId &&
  job.generationId === generationId &&
  job.candidateId === candidate.candidateId &&
  job.jobId === candidate.jobId &&
  job.idempotencyKey === createVoicevoxJobIdempotencyKey(generationId, candidate.candidateId) &&
  job.payloadRef === candidate.payloadRef &&
  job.maxAttempts === maxAttempts &&
  job.expiresAt === expiresAt;

/** Register both candidates atomically. Repeating an identical request is a no-op. */
export const registerVoicevoxJobGroup = (state: VoicevoxJobState, input: RegisterVoicevoxJobGroupInput): VoicevoxJobState => {
  validateRegistrationInput(input);
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const candidates = [...input.candidates].sort((a, b) => a.candidateId.localeCompare(b.candidateId)) as [VoicevoxJobCandidateInput, VoicevoxJobCandidateInput];
  const existingByKey = candidates.map((candidate) =>
    Object.values(state.jobs).find(
      (job) => job.idempotencyKey === createVoicevoxJobIdempotencyKey(input.generationId, candidate.candidateId),
    ),
  );
  if (existingByKey.some(Boolean)) {
    if (existingByKey.every((job, index) => job && isSameCandidate(job, candidates[index], input.groupId, input.generationId, maxAttempts, input.expiresAt))) {
      return state;
    }
    throw new VoicevoxJobStateError("idempotency-conflict", `generation already has a different job for ${input.generationId}`);
  }
  if (state.groups[input.groupId]) {
    throw new VoicevoxJobStateError("duplicate-idempotency-key", `groupId already exists: ${input.groupId}`);
  }
  for (const candidate of candidates) {
    if (state.jobs[candidate.jobId]) {
      throw new VoicevoxJobStateError("duplicate-idempotency-key", `jobId already exists: ${candidate.jobId}`);
    }
  }
  const jobs: VoicevoxJob[] = candidates.map((candidate) => ({
    jobId: candidate.jobId,
    groupId: input.groupId,
    generationId: input.generationId,
    candidateId: candidate.candidateId,
    idempotencyKey: createVoicevoxJobIdempotencyKey(input.generationId, candidate.candidateId),
    ...(candidate.payloadRef === undefined ? {} : { payloadRef: candidate.payloadRef }),
    status: "accepted",
    attempt: 0,
    maxAttempts,
    backend: null,
    leaseId: null,
    resultRef: null,
    failure: null,
    createdAt: input.now,
    updatedAt: input.now,
    expiresAt: input.expiresAt,
  }));
  return {
    groups: {
      ...state.groups,
      [input.groupId]: {
        groupId: input.groupId,
        generationId: input.generationId,
        jobIds: [jobs[0].jobId, jobs[1].jobId],
        status: "accepted",
        createdAt: input.now,
        updatedAt: input.now,
        expiresAt: input.expiresAt,
      },
    },
    jobs: { ...state.jobs, [jobs[0].jobId]: jobs[0], [jobs[1].jobId]: jobs[1] },
    leases: { ...state.leases },
  };
};

const assertTransition = (from: VoicevoxJobStatus, to: VoicevoxJobStatus) => {
  const allowed: Record<VoicevoxJobStatus, readonly VoicevoxJobStatus[]> = {
    accepted: ["queued", "failed", "cancelled"],
    queued: ["running", "failed", "cancelled"],
    running: ["succeeded", "failed", "cancelled"],
    succeeded: [],
    failed: [],
    cancelled: [],
  };
  if (!allowed[from].includes(to)) {
    throw new VoicevoxJobStateError("invalid-transition", `${from} cannot transition to ${to}`);
  }
};

const setJob = (state: VoicevoxJobState, job: VoicevoxJob, now: number, leases = state.leases) => withJob(state, { ...job, updatedAt: now }, now, leases);

export const enqueueVoicevoxJob = (state: VoicevoxJobState, jobId: string, now: number): VoicevoxJobState => {
  assertNow(now);
  const job = getJob(state, jobId);
  assertJobNotExpired(job, now);
  if (job.status === "queued") return state;
  assertTransition(job.status, "queued");
  return setJob(state, { ...job, status: "queued", leaseId: null }, now);
};

export type AcquireVoicevoxLeaseInput = {
  jobId: string;
  leaseId: string;
  backend: VoicevoxBackend;
  now: number;
  durationMs?: number;
};

export const acquireVoicevoxLease = (state: VoicevoxJobState, input: AcquireVoicevoxLeaseInput): VoicevoxJobState => {
  assertNonEmpty(input.jobId, "jobId");
  assertNonEmpty(input.leaseId, "leaseId");
  assertNow(input.now);
  const durationMs = input.durationMs ?? DEFAULT_LEASE_DURATION_MS;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new VoicevoxJobStateError("invalid-input", "durationMs must be greater than zero");
  }
  if (input.backend !== "vpc" && input.backend !== "cloud-run") {
    throw new VoicevoxJobStateError("invalid-input", "backend must be vpc or cloud-run");
  }
  const job = getJob(state, input.jobId);
  assertJobNotExpired(job, input.now);
  if (job.status !== "queued") {
    if (job.status === "running" && job.leaseId === input.leaseId) {
      const existingLease = state.leases[input.leaseId];
      if (existingLease?.backend === input.backend && existingLease.expiresAt > input.now) return state;
      throw new VoicevoxJobStateError("lease-mismatch", `lease parameters do not match job: ${job.jobId}`);
    }
    throw new VoicevoxJobStateError("invalid-transition", `${job.status} cannot acquire a lease`);
  }
  if (job.attempt >= job.maxAttempts) {
    throw new VoicevoxJobStateError("attempt-limit", `job has reached maxAttempts: ${job.jobId}`);
  }
  if (state.leases[input.leaseId]) {
    throw new VoicevoxJobStateError("lease-already-held", `leaseId already exists: ${input.leaseId}`);
  }
  const lease: VoicevoxJobLease = {
    leaseId: input.leaseId,
    jobId: job.jobId,
    backend: input.backend,
    attempt: job.attempt + 1,
    acquiredAt: input.now,
    expiresAt: Math.min(input.now + durationMs, job.expiresAt),
  };
  const nextJob: VoicevoxJob = {
    ...job,
    status: "running",
    attempt: lease.attempt,
    backend: lease.backend,
    leaseId: lease.leaseId,
    failure: null,
  };
  return setJob(state, nextJob, input.now, { ...state.leases, [lease.leaseId]: lease });
};

const assertLease = (state: VoicevoxJobState, job: VoicevoxJob, now: number, leaseId?: string) => {
  if (job.status !== "running" || !job.leaseId) {
    throw new VoicevoxJobStateError("invalid-transition", `${job.status} job does not have a running lease`);
  }
  const expectedLeaseId = leaseId ?? job.leaseId;
  const lease = state.leases[expectedLeaseId];
  if (expectedLeaseId !== job.leaseId || !lease || lease.expiresAt <= now || job.expiresAt <= now) {
    throw new VoicevoxJobStateError("lease-mismatch", `lease does not belong to job: ${job.jobId}`);
  }
  return lease;
};

const terminalJob = (state: VoicevoxJobState, job: VoicevoxJob, status: Extract<VoicevoxJobStatus, "succeeded" | "failed" | "cancelled">, now: number, patch: Partial<VoicevoxJob> = {}) => {
  assertTransition(job.status, status);
  const leases = { ...state.leases };
  if (job.leaseId) delete leases[job.leaseId];
  return setJob(state, { ...job, ...patch, status, leaseId: null }, now, leases);
};

export const succeedVoicevoxJob = (state: VoicevoxJobState, jobId: string, now: number, resultRef?: string, leaseId?: string): VoicevoxJobState => {
  assertNow(now);
  const job = getJob(state, jobId);
  assertLease(state, job, now, leaseId);
  return terminalJob(state, job, "succeeded", now, { resultRef: resultRef ?? job.resultRef, failure: null });
};

export const failVoicevoxJob = (state: VoicevoxJobState, jobId: string, failure: VoicevoxJobFailure, now: number, leaseId?: string): VoicevoxJobState => {
  assertNow(now);
  if (!failure || typeof failure.code !== "string" || failure.code.trim() === "") {
    throw new VoicevoxJobStateError("invalid-input", "failure.code must be a non-empty string");
  }
  const job = getJob(state, jobId);
  assertLease(state, job, now, leaseId);
  const leases = { ...state.leases };
  if (job.leaseId) delete leases[job.leaseId];
  if (failure.retryable && job.attempt < job.maxAttempts) {
    return setJob(state, { ...job, status: "queued", leaseId: null, failure }, now, leases);
  }
  return terminalJob({ ...state, leases }, job, "failed", now, { failure, leaseId: null });
};

export const cancelVoicevoxJob = (state: VoicevoxJobState, jobId: string, now: number, leaseId?: string): VoicevoxJobState => {
  assertNow(now);
  const job = getJob(state, jobId);
  assertJobNotExpired(job, now);
  if (job.status === "running") assertLease(state, job, now, leaseId);
  return terminalJob(state, job, "cancelled", now);
};

export const cancelVoicevoxJobGroup = (state: VoicevoxJobState, groupId: string, now: number): VoicevoxJobState => {
  assertNow(now);
  const group = state.groups[groupId];
  if (!group) throw new VoicevoxJobStateError("unknown-group", `unknown group: ${groupId}`);
  return group.jobIds.reduce((current, jobId) => {
    const job = current.jobs[jobId];
    return TERMINAL_STATUSES.has(job.status) ? current : cancelVoicevoxJob(current, jobId, now);
  }, state);
};

/** Return jobs whose lease expired, requeueing them until their attempt cap. */
export const expireVoicevoxLeases = (state: VoicevoxJobState, now: number): VoicevoxJobState => {
  assertNow(now);
  const expired = Object.values(state.leases).filter(({ expiresAt }) => expiresAt <= now);
  return expired.reduce((current, lease) => {
    const job = current.jobs[lease.jobId];
    if (!job || job.leaseId !== lease.leaseId || job.status !== "running") {
      const leases = { ...current.leases };
      delete leases[lease.leaseId];
      return { ...current, leases };
    }
    const leases = { ...current.leases };
    delete leases[lease.leaseId];
    const jobExpired = job.expiresAt <= now;
    const failure: VoicevoxJobFailure = {
      code: jobExpired ? "job-expired" : "lease-expired",
      retryable: !jobExpired && job.attempt < job.maxAttempts,
    };
    if (jobExpired) {
      return terminalJob({ ...current, leases }, job, "failed", now, { failure, leaseId: null });
    }
    if (job.attempt < job.maxAttempts) {
      return setJob(current, { ...job, status: "queued", leaseId: null, failure }, now, leases);
    }
    return terminalJob({ ...current, leases }, job, "failed", now, { failure, leaseId: null });
  }, state);
};

/** Expire accepted/queued jobs that never acquired a lease. */
export const expireVoicevoxJobs = (state: VoicevoxJobState, now: number): VoicevoxJobState => {
  assertNow(now);
  const withExpiredLeases = expireVoicevoxLeases(state, now);
  return Object.values(withExpiredLeases.jobs).reduce((current, snapshot) => {
    const job = current.jobs[snapshot.jobId];
    if (TERMINAL_STATUSES.has(job.status) || job.expiresAt > now) return current;
    if (job.status === "running") {
      const failure: VoicevoxJobFailure = { code: "job-expired", retryable: false };
      return terminalJob(current, job, "failed", now, { failure });
    }
    return terminalJob(current, job, "failed", now, {
      failure: { code: "job-expired", retryable: false },
    });
  }, withExpiredLeases);
};

export const countWaitingVoicevoxGenerations = (state: VoicevoxJobState): number =>
  new Set(Object.values(state.jobs).filter(({ status }) => status === "accepted" || status === "queued").map(({ generationId }) => generationId)).size;

export type VoicevoxBackendSelectionInput = {
  waitingGenerations: number;
  cloudRunThreshold?: number;
  vpcAvailable?: boolean;
  cloudRunAvailable?: boolean;
};

/**
 * Choose a concrete backend. "auto" is intentionally not a valid result:
 * the consumer must persist and pass the selected vpc/cloud-run value.
 */
export const selectVoicevoxBackend = ({
  waitingGenerations,
  cloudRunThreshold = 2,
  vpcAvailable = true,
  cloudRunAvailable = true,
}: VoicevoxBackendSelectionInput): VoicevoxBackend => {
  if (!Number.isInteger(waitingGenerations) || waitingGenerations < 0) {
    throw new VoicevoxJobStateError("invalid-input", "waitingGenerations must be a non-negative integer");
  }
  if (!Number.isInteger(cloudRunThreshold) || cloudRunThreshold < 1) {
    throw new VoicevoxJobStateError("invalid-input", "cloudRunThreshold must be a positive integer");
  }
  if (waitingGenerations >= cloudRunThreshold && cloudRunAvailable) return "cloud-run";
  if (vpcAvailable) return "vpc";
  if (cloudRunAvailable) return "cloud-run";
  throw new VoicevoxJobStateError("invalid-input", "no VOICEVOX backend is available");
};
