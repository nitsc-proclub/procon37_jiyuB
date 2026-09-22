import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true }, appType: "custom" });
const jobs = await vite.ssrLoadModule("/services/voicevoxJobService.ts");
const originalFetch = globalThis.fetch;
const capability = "v1.test.999999999999.signature";
const candidates = [{ candidateId: "candidate-a", voiceGrant: "a", score: { notes: [] } }, { candidateId: "candidate-b", voiceGrant: "b", score: { notes: [] } }];

test("registration retries an ambiguous transport failure and validates exact A/B correspondence", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("network");
    return Response.json({ groupId: "g", duplicate: true, jobs: [{ jobId: "g:candidate-a", candidateId: "candidate-a", status: "queued" }, { jobId: "g:candidate-b", candidateId: "candidate-b", status: "queued" }] });
  };
  const result = await jobs.registerVoicevoxJobGroup({ capability, groupId: "g", generationId: "g", candidates });
  assert.equal(calls, 2); assert.equal(result.duplicate, true);
  assert.deepEqual(result.jobs.map(job => job.backend), [null, null]);
  globalThis.fetch = async () => Response.json({ groupId: "g", duplicate: false, jobs: [{ jobId: "g:candidate-a", candidateId: "candidate-a", status: "queued" }, { jobId: "bad", candidateId: "candidate-a", status: "queued" }] });
  await assert.rejects(jobs.registerVoicevoxJobGroup({ capability, groupId: "g", generationId: "g", candidates }), /invalid-registration/);
});

test("poll retries a transient status error and cancellation uses the authenticated endpoint", async () => {
  let getCalls = 0; let cancelUrl = "";
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/cancel")) { cancelUrl = String(url); assert.equal(init.headers["X-Voicevox-Capability"], capability); return Response.json({ status: "cancelled" }); }
    getCalls += 1; if (getCalls === 1) throw new TypeError("network");
    return Response.json({ jobId: "g:candidate-a", status: "succeeded", audioReady: true, expiresAt: 1 });
  };
  const state = await jobs.waitForVoicevoxJobs([{ jobId: "g:candidate-a" }], capability, { intervalMs: 1, timeoutMs: 500 });
  assert.equal(state[0].status, "succeeded"); assert.equal(getCalls, 2);
  assert.equal(state[0].backend, null);
  await jobs.cancelVoicevoxJob("g:candidate-a", capability);
  assert.equal(cancelUrl, "/api/voicevox/jobs/g%3Acandidate-a/cancel");
});

for (const backendPreference of ["auto", "vpc", "cloud-run"]) test(`registration sends ${backendPreference} and polling preserves the actual server`, async () => {
  const backend = backendPreference === "vpc" ? "vpc" : "cloud-run";
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.headers["X-Voicevox-Capability"], capability);
    if (String(url).endsWith("/register")) {
      const input = JSON.parse(init.body);
      assert.equal(input.backendPreference, backendPreference);
      assert.equal(input.candidates.length, 1);
      return Response.json({ groupId: "g", duplicate: false, jobs: [{ jobId: "g:candidate-a", candidateId: "candidate-a", status: "queued", backend }] });
    }
    return Response.json({ jobId: "g:candidate-a", status: "succeeded", backend, audioReady: true, expiresAt: 1 });
  };
  const registration = await jobs.registerVoicevoxJobGroup({ capability, groupId: "g", generationId: "g", candidates: candidates.slice(0, 1), backendPreference });
  assert.equal(registration.jobs[0].backend, backend);
  const completed = await jobs.waitForVoicevoxJobs(registration.jobs, capability, { intervalMs: 1, timeoutMs: 500 });
  assert.equal(completed[0].backend, backend);
});

test.after(async () => { globalThis.fetch = originalFetch; await vite.close(); });
