import type { VoicevoxJobDatabase } from "./voicevoxJobRepository";
import {
  claimVoicevoxJobDispatch,
  listVoicevoxRedispatchableJobs,
  markVoicevoxJobDispatched,
  type DispatchLeaseInput,
  type VoicevoxLifecycleJob,
  type VoicevoxLifecycleResult,
} from "./voicevoxJobLifecycle";

/** References only: lyrics, score, credentials and audio never enter Queue. */
export type VoicevoxQueueMessage = {
  schemaVersion: 1;
  jobId: string;
  generationId: string;
  candidateId: "candidate-a" | "candidate-b";
};
export type VoicevoxQueueProducer = {
  send(message: VoicevoxQueueMessage): Promise<void>;
};
export type VoicevoxDispatchRepository = {
  list(input: {
    now: number;
    staleAfterMs: number;
    limit: number;
  }): Promise<readonly VoicevoxLifecycleJob[]>;
  claim(input: DispatchLeaseInput): Promise<VoicevoxLifecycleResult>;
  mark(input: {
    jobId: string;
    dispatchLeaseId: string;
    now: number;
  }): Promise<VoicevoxLifecycleResult>;
};

export const voicevoxDispatchRepository = (
  database: VoicevoxJobDatabase,
): VoicevoxDispatchRepository => ({
  list: (input) => listVoicevoxRedispatchableJobs(database, input),
  claim: (input) => claimVoicevoxJobDispatch(database, input),
  mark: (input) => markVoicevoxJobDispatched(database, input),
});

/**
 * Bounded outbox pass, intended for a future scheduled handler / registration.
 * Send precedes mark. An ambiguous send or mark failure leaves a recoverable
 * dispatch lease; redelivery is safe only with the consumer's D1 claim fence.
 * No timer, external binding, or public route is enabled merely by importing it.
 */
export const dispatchVoicevoxJobs = async (
  repository: VoicevoxDispatchRepository,
  queue: VoicevoxQueueProducer,
  options: {
    limit?: number;
    now?: () => number;
    newLeaseId?: () => string;
  } = {},
) => {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid dispatch limit");
  const clock = options.now ?? Date.now;
  const now = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("invalid dispatch time");
    return value;
  };
  const newLeaseId = options.newLeaseId ?? (() => crypto.randomUUID());
  const jobs = await repository.list({
    now: now(),
    staleAfterMs: 300_000,
    limit,
  });
  const totals = { scanned: 0, sent: 0, marked: 0, skipped: 0, failed: 0 };
  // Deliberately sequential: each pass is bounded and does not burst Queue/D1.
  for (const candidate of jobs.slice(0, limit)) {
    totals.scanned += 1;
    try {
      const dispatchLeaseId = newLeaseId();
      const startedAt = now();
      const claimed = await repository.claim({
        jobId: candidate.jobId,
        dispatchLeaseId,
        now: startedAt,
        leaseExpiresAt: Math.min(startedAt + 30_000, candidate.expiresAt),
      });
      // A duplicate lease observation is NOT ownership of a fresh dispatch.
      if (claimed.outcome !== "applied" || !claimed.job) {
        totals.skipped += 1;
        continue;
      }
      const job = claimed.job;
      const sendAt = now();
      if (
        job.expiresAt <= sendAt ||
        job.dispatchLeaseId !== dispatchLeaseId ||
        !job.dispatchLeaseExpiresAt ||
        job.dispatchLeaseExpiresAt <= sendAt ||
        (job.status !== "accepted" && job.status !== "queued")
      ) {
        totals.skipped += 1;
        continue;
      }
      await queue.send({
        schemaVersion: 1,
        jobId: job.jobId,
        generationId: job.generationId,
        candidateId: job.candidateId,
      });
      totals.sent += 1;
      const marked = await repository.mark({
        jobId: job.jobId,
        dispatchLeaseId,
        now: now(),
      });
      if (marked.outcome === "applied") totals.marked += 1;
      else totals.skipped += 1; // Consumer may already be running/completed.
    } catch {
      // Do not log arbitrary transport errors: they may contain credentials or
      // payloads. The next pass retries after the persisted dispatch lease.
      totals.failed += 1;
    }
  }
  return totals;
};
