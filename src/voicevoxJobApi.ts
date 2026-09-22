import { cancelVoicevoxJob } from "./voicevoxJobLifecycle";
import { registerVoicevoxJobs, type VoicevoxJobDatabase } from "./voicevoxJobRepository";
import type { VoicevoxQueueProducers } from "./voicevoxJobDispatcher";
import { readTemporaryVoicevoxWav, type TemporaryAudioR2Bucket } from "./voicevoxTemporaryAudio";
import { parseSingingScore } from "./voicevoxBackend";

const encoder = new TextEncoder();
const MAX_BODY = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), x => x.toString(16).padStart(2, "0")).join("");
const sign = async (secret: string, message: string) => b64(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), encoder.encode(message))));
export const createVoicevoxJobCapability = async (generationId: string, secret: string, now = Date.now(), ttlMs = 60 * 60_000) => {
  if (!UUID.test(generationId) || secret.length < 32) throw new Error("voice job capability config is invalid");
  const expiresAt = now + ttlMs; return `v1.${generationId}.${expiresAt}.${await sign(secret, `v1.${generationId}.${expiresAt}`)}`;
};
const verify = async (value: string | null, generationId: string, secret: string, now: number) => {
  if (!value || secret.length < 32) return false; const parts = value.split(".");
  if (!(parts.length === 4 && parts[0] === "v1" && parts[1] === generationId && /^\d+$/.test(parts[2]) && Number(parts[2]) > now && /^[A-Za-z0-9_-]+$/.test(parts[3]))) return false;
  const raw = Uint8Array.from(atob(parts[3].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[3].length / 4) * 4, "=")), c => c.charCodeAt(0));
  return crypto.subtle.verify("HMAC", await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]), raw, encoder.encode(`${parts[0]}.${parts[1]}.${parts[2]}`));
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const sameOrigin = (request: Request) => { const origin = request.headers.get("Origin"); if (origin) return origin === new URL(request.url).origin; return request.method === "GET" && request.headers.get("Sec-Fetch-Site") !== "cross-site"; };
const body = async (request: Request) => { const length = Number(request.headers.get("content-length")); if (Number.isFinite(length) && length > MAX_BODY) throw new Error("too-large"); if (!request.body) throw new Error("invalid"); const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0; try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > MAX_BODY) { await reader.cancel(); throw new Error("too-large"); } chunks.push(next.value); } } finally { reader.releaseLock(); } const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; };
export type VoicevoxJobApiEnv = { EVALUATIONS_DB: VoicevoxJobDatabase; TEMPORARY_AUDIO: TemporaryAudioR2Bucket; EVALUATION_RECEIPT_SECRET: string; VOICEVOX_JOB_QUEUES: VoicevoxQueueProducers; CLOUD_RUN_OVERFLOW_GENERATIONS?: string };

/** Mount under `/api/voicevox/jobs`; main Worker owns the route dispatch. */
export const handleVoicevoxJobApi = async (request: Request, env: VoicevoxJobApiEnv): Promise<Response> => {
  if (!sameOrigin(request)) return json({ code: "invalid-origin" }, 403);
  const url = new URL(request.url); const suffix = url.pathname.replace(/^.*\/api\/voicevox\/jobs/, "");
  try {
    if (request.method === "POST" && suffix === "/register") {
      if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ code: "invalid-content-type" }, 415);
      const value = await body(request); const generationId = typeof value.generationId === "string" ? value.generationId : "";
      if (!await verify(request.headers.get("X-Voicevox-Capability"), generationId, env.EVALUATION_RECEIPT_SECRET, Date.now())) return json({ code: "invalid-capability" }, 403);
      if (!Array.isArray(value.candidates) || ![1, 2].includes(value.candidates.length) || typeof value.groupId !== "string") return json({ code: "invalid-job-request" }, 400);
      const candidates = await Promise.all(value.candidates.map(async (item) => {
        if (!item || typeof item !== "object") throw new Error("invalid"); const candidate = item as Record<string, unknown>;
        const score = parseSingingScore(candidate.score); const scoreJson = JSON.stringify(score); const rawCandidateId = candidate.candidateId;
        if ((rawCandidateId !== "candidate-a" && rawCandidateId !== "candidate-b") || typeof candidate.voiceGrant !== "string") throw new Error("invalid"); const candidateId: "candidate-a" | "candidate-b" = rawCandidateId;
        return { candidateId, jobId: `${generationId}:${candidateId}`, scoreJson, scoreHash: await hash(scoreJson), grantHash: await hash(candidate.voiceGrant) };
      }));
      const now = Date.now(); const capabilityExpiry = Number(request.headers.get("X-Voicevox-Capability")?.split(".")[2]); const overflowGenerations = Number(env.CLOUD_RUN_OVERFLOW_GENERATIONS ?? "2"); const registered = await registerVoicevoxJobs(env.EVALUATIONS_DB, { groupId: value.groupId, generationId, candidates, now, expiresAt: capabilityExpiry, cloudRunOverflowGenerations: overflowGenerations });
      // Registration is durable before delivery; the queue only accelerates the outbox pass.
      await Promise.all(registered.jobs.map(job => {
        if (job.backend !== "vpc" && job.backend !== "cloud-run") return Promise.reject(new Error("voice job backend is missing"));
        return env.VOICEVOX_JOB_QUEUES[job.backend].send({ schemaVersion: 1, jobId: job.jobId, generationId, candidateId: job.candidateId });
      })).catch(() => undefined);
      return json({ groupId: registered.group.groupId, jobs: registered.jobs.map(job => ({ jobId: job.jobId, candidateId: job.candidateId, status: job.status })), duplicate: !registered.created }, 202);
    }
    const rawJobId = suffix.match(/^\/([^/]+)(?:\/(audio|cancel))?$/)?.[1]; const jobId = rawJobId ? decodeURIComponent(rawJobId) : undefined; const action = suffix.match(/^\/[^/]+(?:\/(audio|cancel))?$/)?.[1];
    if (!jobId) return json({ code: "not-found" }, 404);
    const rows = await env.EVALUATIONS_DB.prepare("SELECT job_id, generation_id, status, result_ref, expires_at FROM voicevox_jobs WHERE job_id = ?").bind(jobId).all<{ job_id: string; generation_id: string; status: string; result_ref: string | null; expires_at: number }>(); const job = rows.results[0];
    if (!job || !await verify(request.headers.get("X-Voicevox-Capability"), job.generation_id, env.EVALUATION_RECEIPT_SECRET, Date.now())) return json({ code: "not-found" }, 404);
    if (action === "audio" && request.method === "GET") return job.status === "succeeded" && job.result_ref ? readTemporaryVoicevoxWav(env.TEMPORARY_AUDIO, job.result_ref) : json({ code: "audio-not-ready" }, 409);
    if (action === "cancel" && request.method === "POST") { const cancelled = await cancelVoicevoxJob(env.EVALUATIONS_DB, { jobId, now: Date.now() }); return json({ status: cancelled.job?.status }, 202); }
    if (!action && request.method === "GET") return json({ jobId: job.job_id, status: job.status, audioReady: job.status === "succeeded" && !!job.result_ref, expiresAt: job.expires_at });
    return json({ code: "method-not-allowed" }, 405);
  } catch { return json({ code: "voice-job-failed" }, 400); }
};
