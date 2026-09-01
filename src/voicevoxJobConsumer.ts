import { claimVoicevoxJob, completeVoicevoxJob, failVoicevoxJob } from "./voicevoxJobLifecycle";
import type { VoicevoxJobDatabase } from "./voicevoxJobRepository";
import { synthesizeWithVoicevoxBackend, type VoicevoxAttemptError } from "./voicevoxBackend";
import { storeTemporaryVoicevoxWav, type TemporaryAudioR2Bucket } from "./voicevoxTemporaryAudio";

export type VoicevoxJobQueueMessage = { schemaVersion: 1; jobId: string; generationId: string; candidateId: "candidate-a" | "candidate-b" };
type VoicevoxPoolRpc = { acquire(request: { backend: "vpc"; jobId: string; generationId: string; attempt: number }): Promise<{ granted: boolean; lease?: { leaseId: string; expiresAt: number } }>; release(request: { backend: "vpc"; jobId: string; generationId: string; attempt: number; leaseId: string }): Promise<unknown> };
export type VoicevoxJobConsumerEnv = { EVALUATIONS_DB: VoicevoxJobDatabase; TEMPORARY_AUDIO: TemporaryAudioR2Bucket; VOICEVOX: Fetcher; VOICEVOX_BACKEND_POOL: { getByName(name: string): VoicevoxPoolRpc }; VPC_CAPACITY: string; CLOUD_RUN_CAPACITY: string };
type Payload = { score_json: string };

/** Queue consumer: VPC only in the initial rollout. Queue concurrency is configured as one. */
export const consumeVoicevoxJob = async (message: VoicevoxJobQueueMessage, env: VoicevoxJobConsumerEnv): Promise<"ack" | "retry"> => {
  if (!message || message.schemaVersion !== 1 || typeof message.jobId !== "string" || typeof message.generationId !== "string" || !["candidate-a", "candidate-b"].includes(message.candidateId)) return "ack";
  const now = Date.now(); const jobRows = await env.EVALUATIONS_DB.prepare("SELECT job_id, generation_id, attempt, max_attempts, expires_at FROM voicevox_jobs WHERE job_id = ? AND generation_id = ?").bind(message.jobId, message.generationId).all<{ job_id: string; generation_id: string; attempt: number; max_attempts: number; expires_at: number }>(); const job = jobRows.results[0];
  if (!job || job.expires_at <= now) return "ack";
  const pool = env.VOICEVOX_BACKEND_POOL.getByName("voicevox-backend-pool:v1:vpc"); const lease = await pool.acquire({ backend: "vpc", jobId: job.job_id, generationId: job.generation_id, attempt: job.attempt + 1 });
  if (!lease.granted || !lease.lease) return "retry";
  try {
    const claimed = await claimVoicevoxJob(env.EVALUATIONS_DB, { jobId: job.job_id, leaseId: lease.lease.leaseId, attempt: job.attempt + 1, backend: "vpc", now: Date.now(), leaseExpiresAt: lease.lease.expiresAt });
    if (claimed.outcome !== "applied" || !claimed.job) return "ack";
    const payload = await env.EVALUATIONS_DB.prepare("SELECT score_json FROM voicevox_job_payloads WHERE job_id = ?").bind(job.job_id).all<Payload>();
    if (!payload.results[0]) { await failVoicevoxJob(env.EVALUATIONS_DB, { jobId: job.job_id, leaseId: lease.lease.leaseId, attempt: claimed.job.attempt, errorCode: "payload-missing", retryable: false, now: Date.now() }); return "ack"; }
    const score = JSON.parse(payload.results[0].score_json);
    const synthesis = await synthesizeWithVoicevoxBackend(env, "vpc", score);
    const audio = await storeTemporaryVoicevoxWav(env.TEMPORARY_AUDIO, { jobId: job.job_id, attempt: claimed.job.attempt, leaseId: lease.lease.leaseId }, synthesis.response.body!, { now: Date.now() });
    const completed = await completeVoicevoxJob(env.EVALUATIONS_DB, { jobId: job.job_id, leaseId: lease.lease.leaseId, attempt: claimed.job.attempt, resultRef: audio.audioId, resultExpiresAt: audio.expiresAt, now: Date.now() });
    return completed.outcome === "applied" || completed.outcome === "duplicate" ? "ack" : "retry";
  } catch (error) {
    const failure = error as Partial<VoicevoxAttemptError>; const retryable = failure.retryable !== false;
    await failVoicevoxJob(env.EVALUATIONS_DB, { jobId: job.job_id, leaseId: lease.lease.leaseId, attempt: job.attempt + 1, errorCode: typeof failure.code === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(failure.code) ? failure.code : "voice-consumer-failed", retryable, now: Date.now() });
    return retryable ? "retry" : "ack";
  } finally { await pool.release({ backend: "vpc", jobId: job.job_id, generationId: job.generation_id, attempt: job.attempt + 1, leaseId: lease.lease.leaseId }); }
};
