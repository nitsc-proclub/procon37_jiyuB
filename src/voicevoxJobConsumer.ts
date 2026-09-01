import { claimVoicevoxJob, completeVoicevoxJob, failVoicevoxJob } from "./voicevoxJobLifecycle";
import type { VoicevoxJobDatabase } from "./voicevoxJobRepository";
import { synthesizeWithVoicevoxBackend, type VoicevoxAttemptError } from "./voicevoxBackend";
import { storeTemporaryVoicevoxWav, type TemporaryAudioR2Bucket } from "./voicevoxTemporaryAudio";
import type { VoicevoxBackend } from "./voicevoxJobState";

export type VoicevoxJobQueueMessage = { schemaVersion: 1; jobId: string; generationId: string; candidateId: "candidate-a" | "candidate-b" };
export type VoicevoxPoolRpc = { acquire(request: { backend: VoicevoxBackend; jobId: string; generationId: string; attempt: number }): Promise<{ granted: boolean; lease?: { leaseId: string; expiresAt: number } }>; release(request: { backend: VoicevoxBackend; jobId: string; generationId: string; attempt: number; leaseId: string }): Promise<unknown> };
export type VoicevoxPoolServiceRpc = {
  acquireBackendLease: VoicevoxPoolRpc["acquire"];
  releaseBackendLease: VoicevoxPoolRpc["release"];
};
export const voicevoxPoolRpcFromService = (service: VoicevoxPoolServiceRpc): VoicevoxPoolRpc => ({
  acquire: (request) => service.acquireBackendLease(request),
  release: (request) => service.releaseBackendLease(request),
});
export type VoicevoxJobConsumerEnv = { EVALUATIONS_DB: VoicevoxJobDatabase; TEMPORARY_AUDIO: TemporaryAudioR2Bucket; VOICEVOX?: Fetcher; VOICEVOX_BACKEND_POOL: VoicevoxPoolRpc; VOICEVOX_CLOUD_RUN_URL?: string; VOICEVOX_GCP_SERVICE_ACCOUNT_JSON?: string };
type Payload = { score_json: string };

/** One backend-specific Queue invokes this with an explicit backend; never use auto/fallback here. */
export const consumeVoicevoxJob = async (message: VoicevoxJobQueueMessage, env: VoicevoxJobConsumerEnv, backend: VoicevoxBackend = "vpc"): Promise<"ack" | "retry"> => {
  if (!message || message.schemaVersion !== 1 || typeof message.jobId !== "string" || typeof message.generationId !== "string" || !["candidate-a", "candidate-b"].includes(message.candidateId)) return "ack";
  const now = Date.now(); const jobRows = await env.EVALUATIONS_DB.prepare("SELECT job_id, generation_id, attempt, max_attempts, expires_at, backend FROM voicevox_jobs WHERE job_id = ? AND generation_id = ?").bind(message.jobId, message.generationId).all<{ job_id: string; generation_id: string; attempt: number; max_attempts: number; expires_at: number; backend: VoicevoxBackend | null }>(); const job = jobRows.results[0];
  if (!job || job.expires_at <= now) return "ack";
  // A stale/duplicate message from the other backend Queue is never allowed to
  // change the D1-selected route.
  if ((job.backend ?? "vpc") !== backend) return "ack";
  const lease = await env.VOICEVOX_BACKEND_POOL.acquire({ backend, jobId: job.job_id, generationId: job.generation_id, attempt: job.attempt + 1 });
  if (!lease.granted || !lease.lease) return "retry";
  try {
    const claimed = await claimVoicevoxJob(env.EVALUATIONS_DB, { jobId: job.job_id, leaseId: lease.lease.leaseId, attempt: job.attempt + 1, backend, now: Date.now(), leaseExpiresAt: lease.lease.expiresAt });
    if (claimed.outcome !== "applied" || !claimed.job) return "ack";
    const payload = await env.EVALUATIONS_DB.prepare("SELECT score_json FROM voicevox_job_payloads WHERE job_id = ?").bind(job.job_id).all<Payload>();
    if (!payload.results[0]) { await failVoicevoxJob(env.EVALUATIONS_DB, { jobId: job.job_id, leaseId: lease.lease.leaseId, attempt: claimed.job.attempt, errorCode: "payload-missing", retryable: false, now: Date.now() }); return "ack"; }
    const score = JSON.parse(payload.results[0].score_json);
    const synthesis = await synthesizeWithVoicevoxBackend(env, backend, score);
    const audio = await storeTemporaryVoicevoxWav(env.TEMPORARY_AUDIO, { jobId: job.job_id, attempt: claimed.job.attempt, leaseId: lease.lease.leaseId }, synthesis.response.body!, { now: Date.now() });
    const completed = await completeVoicevoxJob(env.EVALUATIONS_DB, { jobId: job.job_id, leaseId: lease.lease.leaseId, attempt: claimed.job.attempt, resultRef: audio.audioId, resultExpiresAt: audio.expiresAt, now: Date.now() });
    return completed.outcome === "applied" || completed.outcome === "duplicate" ? "ack" : "retry";
  } catch (error) {
    const failure = error as Partial<VoicevoxAttemptError>; const retryable = failure.retryable !== false;
    await failVoicevoxJob(env.EVALUATIONS_DB, { jobId: job.job_id, leaseId: lease.lease.leaseId, attempt: job.attempt + 1, errorCode: typeof failure.code === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(failure.code) ? failure.code : "voice-consumer-failed", retryable, now: Date.now() });
    return retryable ? "retry" : "ack";
  } finally { await env.VOICEVOX_BACKEND_POOL.release({ backend, jobId: job.job_id, generationId: job.generation_id, attempt: job.attempt + 1, leaseId: lease.lease.leaseId }); }
};
