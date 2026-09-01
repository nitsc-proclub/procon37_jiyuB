export type VoicevoxJobCapability = string;
export type VoicevoxJobCandidate = { candidateId: "candidate-a" | "candidate-b"; voiceGrant: string; score: unknown };
export type VoicevoxJobRegistration = { groupId: string; jobs: readonly { jobId: string; candidateId: "candidate-a" | "candidate-b"; status: string }[]; duplicate: boolean };
const json = async <T>(response: Response): Promise<T> => { const value = await response.json().catch(() => ({})); if (!response.ok) throw new Error(typeof (value as { code?: unknown }).code === "string" ? (value as { code: string }).code : "voice-job-failed"); return value as T; };
const headers = (capability: VoicevoxJobCapability) => ({ "Content-Type": "application/json", "X-Voicevox-Capability": capability });
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => { const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); }; const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); });
const assertRegistration = (value: VoicevoxJobRegistration, candidates: readonly VoicevoxJobCandidate[]) => {
  const expected = new Set(candidates.map((candidate) => candidate.candidateId));
  if (!value || typeof value.groupId !== "string" || !Array.isArray(value.jobs) || value.jobs.length !== expected.size
    || new Set(value.jobs.map((job) => job.candidateId)).size !== expected.size
    || value.jobs.some((job) => !expected.has(job.candidateId) || typeof job.jobId !== "string" || job.jobId.length < 1)) throw new Error("voice-job-invalid-registration");
  return value;
};
export const registerVoicevoxJobGroup = async (input: { capability: VoicevoxJobCapability; groupId: string; generationId: string; candidates: readonly VoicevoxJobCandidate[]; signal?: AbortSignal }) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    input.signal?.throwIfAborted();
    try {
      const response = await fetch("/api/voicevox/jobs/register", { method: "POST", headers: headers(input.capability), body: JSON.stringify({ groupId: input.groupId, generationId: input.generationId, candidates: input.candidates }), signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
      return assertRegistration(await json<VoicevoxJobRegistration>(response), input.candidates);
    } catch (error) { lastError = error; if (attempt === 0 && !input.signal?.aborted) await sleep(250, input.signal); }
  }
  throw lastError;
};
export const getVoicevoxJob = async (jobId: string, capability: VoicevoxJobCapability, signal?: AbortSignal) => json<{ jobId: string; status: string; audioReady: boolean; expiresAt: number }>(await fetch(`/api/voicevox/jobs/${encodeURIComponent(jobId)}`, { headers: { "X-Voicevox-Capability": capability }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }));
/** Poll only the registered jobs. Never call the old synchronous synthesis route after grants are consumed. */
export const waitForVoicevoxJobs = async (jobs: readonly { jobId: string }[], capability: VoicevoxJobCapability, options: { signal?: AbortSignal; timeoutMs?: number; intervalMs?: number } = {}) => {
  const timeoutMs = options.timeoutMs ?? 8 * 60_000, interval = options.intervalMs ?? 1_500, controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error("voice-job-timeout")), timeoutMs); const abort = () => controller.abort(options.signal?.reason ?? new DOMException("Aborted", "AbortError")); options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try { while (true) { controller.signal.throwIfAborted(); try { const states = await Promise.all(jobs.map(job => getVoicevoxJob(job.jobId, capability, controller.signal))); if (states.every(job => ["succeeded", "failed", "cancelled"].includes(job.status))) return states; } catch (error) { if (controller.signal.aborted) throw error; } await sleep(interval, controller.signal); } } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
};
export const voicevoxJobAudioUrl = (jobId: string) => `/api/voicevox/jobs/${encodeURIComponent(jobId)}/audio`;
export const cancelVoicevoxJob = async (jobId: string, capability: VoicevoxJobCapability, signal?: AbortSignal) => json<{ status: string }>(await fetch(`/api/voicevox/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", headers: headers(capability), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }));
export const cancelVoicevoxJobGroup = async (jobs: readonly { jobId: string }[], capability: VoicevoxJobCapability) => Promise.allSettled(jobs.map((job) => cancelVoicevoxJob(job.jobId, capability)));
