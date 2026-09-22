import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  appType: "custom",
});
const jobs = await vite.ssrLoadModule("/src/voicevoxJobState.ts");
test.after(async () => {
  await vite.close();
});

const register = (overrides = {}) =>
  jobs.registerVoicevoxJobGroup(
    jobs.createVoicevoxJobState(),
    {
      groupId: "group-1",
      generationId: "generation-1",
      candidates: [
        { candidateId: "candidate-a", jobId: "job-a", payloadRef: "payload-a" },
        { candidateId: "candidate-b", jobId: "job-b", payloadRef: "payload-b" },
      ],
      now: 1000,
      expiresAt: 10_000,
      ...overrides,
    },
  );

test("registration caps synthesis attempts before accepting jobs", () => {
  for (const maxAttempts of [0, 6, Infinity, 1.5]) {
    assert.throws(() => register({ maxAttempts }), (error) => error.code === "invalid-input");
  }
  assert.equal(register({ maxAttempts: 5 }).jobs["job-a"].maxAttempts, 5);
});

test("registers A/B atomically with generation/candidate idempotency keys", () => {
  const state = register();
  assert.deepEqual(state.groups["group-1"].jobIds, ["job-a", "job-b"]);
  assert.equal(state.jobs["job-a"].status, "accepted");
  assert.equal(state.jobs["job-a"].idempotencyKey, "generation-1:candidate-a");
  assert.equal(state.jobs["job-b"].idempotencyKey, "generation-1:candidate-b");
  assert.equal(jobs.countWaitingVoicevoxGenerations(state), 1);

  const retried = jobs.registerVoicevoxJobGroup(state, {
    groupId: "group-1",
    generationId: "generation-1",
    candidates: [
      { candidateId: "candidate-b", jobId: "job-b", payloadRef: "payload-b" },
      { candidateId: "candidate-a", jobId: "job-a", payloadRef: "payload-a" },
    ],
    now: 2000,
    expiresAt: 10_000,
  });
  assert.strictEqual(retried, state);
  assert.throws(
    () =>
      jobs.registerVoicevoxJobGroup(state, {
        groupId: "group-1",
        generationId: "generation-1",
        candidates: [
          { candidateId: "candidate-a", jobId: "job-new" },
          { candidateId: "candidate-b", jobId: "job-b", payloadRef: "payload-b" },
        ],
        now: 2000,
        expiresAt: 10_000,
      }),
    (error) => error.code === "idempotency-conflict",
  );
});

test("rejects candidate-b alone and duplicate candidates", () => {
  assert.throws(
    () =>
      register({
        candidates: [{ candidateId: "candidate-b", jobId: "only-job" }],
      }),
    (error) => error.code === "invalid-input",
  );
  assert.throws(
    () =>
      register({
        candidates: [
          { candidateId: "candidate-a", jobId: "job-a" },
          { candidateId: "candidate-a", jobId: "job-b" },
        ],
      }),
    (error) => error.code === "invalid-input",
  );
});

test("enforces accepted -> queued -> running -> succeeded and protects terminal state", () => {
  let state = register();
  state = jobs.enqueueVoicevoxJob(state, "job-a", 1100);
  assert.equal(state.jobs["job-a"].status, "queued");
  state = jobs.acquireVoicevoxLease(state, {
    jobId: "job-a",
    leaseId: "lease-a-1",
    backend: "vpc",
    now: 1200,
    durationMs: 100,
  });
  assert.equal(state.jobs["job-a"].status, "running");
  assert.equal(state.jobs["job-a"].attempt, 1);
  assert.equal(state.jobs["job-a"].backend, "vpc");
  state = jobs.succeedVoicevoxJob(state, "job-a", 1250, "r2/audio-a", "lease-a-1");
  assert.equal(state.jobs["job-a"].status, "succeeded");
  assert.equal(Object.keys(state.leases).length, 0);
  assert.throws(() => jobs.cancelVoicevoxJob(state, "job-a", 1300), (error) => error.code === "invalid-transition");
  assert.throws(() => jobs.enqueueVoicevoxJob(state, "job-a", 1300), (error) => error.code === "invalid-transition");
});

test("lease expiry requeues a job and final expiry reaches failed at attempt cap", () => {
  let state = register({ maxAttempts: 2 });
  state = jobs.enqueueVoicevoxJob(state, "job-a", 1100);
  state = jobs.acquireVoicevoxLease(state, { jobId: "job-a", leaseId: "lease-a-1", backend: "vpc", now: 1200, durationMs: 10 });
  state = jobs.expireVoicevoxLeases(state, 1210);
  assert.equal(state.jobs["job-a"].status, "queued");
  assert.equal(state.jobs["job-a"].attempt, 1);
  assert.equal(state.jobs["job-a"].failure.code, "lease-expired");
  state = jobs.acquireVoicevoxLease(state, { jobId: "job-a", leaseId: "lease-a-2", backend: "cloud-run", now: 1300, durationMs: 10 });
  state = jobs.expireVoicevoxLeases(state, 1310);
  assert.equal(state.jobs["job-a"].status, "failed");
  assert.equal(state.jobs["job-a"].attempt, 2);
  assert.equal(state.jobs["job-a"].failure.retryable, false);
  assert.throws(() => jobs.acquireVoicevoxLease(state, { jobId: "job-a", leaseId: "lease-a-3", backend: "vpc", now: 1400 }), (error) => error.code === "invalid-transition");
});

test("rejects stale or conflicting lease completion", () => {
  let state = register();
  state = jobs.enqueueVoicevoxJob(state, "job-a", 1100);
  state = jobs.acquireVoicevoxLease(state, { jobId: "job-a", leaseId: "lease-a", backend: "vpc", now: 1200, durationMs: 10 });
  assert.throws(
    () => jobs.acquireVoicevoxLease(state, { jobId: "job-a", leaseId: "lease-a", backend: "cloud-run", now: 1205, durationMs: 10 }),
    (error) => error.code === "lease-mismatch",
  );
  assert.throws(
    () => jobs.succeedVoicevoxJob(state, "job-a", 1210, "r2/audio-a", "lease-a"),
    (error) => error.code === "lease-mismatch",
  );
});

test("does not enqueue or complete work after the job retention deadline", () => {
  const accepted = register({ expiresAt: 1200 });
  assert.throws(() => jobs.enqueueVoicevoxJob(accepted, "job-a", 1200), (error) => error.code === "job-expired");
  assert.throws(() => jobs.cancelVoicevoxJob(accepted, "job-a", 1200), (error) => error.code === "job-expired");

  let running = jobs.enqueueVoicevoxJob(accepted, "job-a", 1100);
  running = jobs.acquireVoicevoxLease(running, { jobId: "job-a", leaseId: "lease-a", backend: "vpc", now: 1150, durationMs: 100 });
  assert.equal(running.leases["lease-a"].expiresAt, 1200);
  assert.throws(
    () => jobs.succeedVoicevoxJob(running, "job-a", 1200, "r2/audio-a", "lease-a"),
    (error) => error.code === "lease-mismatch",
  );

  const expired = jobs.expireVoicevoxJobs(running, 1200);
  assert.equal(expired.jobs["job-a"].status, "failed");
  assert.equal(expired.jobs["job-a"].failure.code, "job-expired");
  assert.equal(expired.jobs["job-b"].status, "failed");
  assert.equal(Object.keys(expired.leases).length, 0);
});

test("retryable failures requeue below the attempt cap; non-retryable failures terminate", () => {
  let state = register({ maxAttempts: 2 });
  state = jobs.enqueueVoicevoxJob(state, "job-a", 1100);
  state = jobs.acquireVoicevoxLease(state, { jobId: "job-a", leaseId: "lease-a-1", backend: "vpc", now: 1200 });
  state = jobs.failVoicevoxJob(state, "job-a", { code: "timeout", retryable: true }, 1300, "lease-a-1");
  assert.equal(state.jobs["job-a"].status, "queued");
  state = jobs.acquireVoicevoxLease(state, { jobId: "job-a", leaseId: "lease-a-2", backend: "cloud-run", now: 1400 });
  state = jobs.failVoicevoxJob(state, "job-a", { code: "bad-query", retryable: false }, 1500, "lease-a-2");
  assert.equal(state.jobs["job-a"].status, "failed");
  assert.equal(state.jobs["job-a"].failure.code, "bad-query");
});

test("cancels an entire group and keeps terminal jobs immutable", () => {
  let state = register();
  state = jobs.enqueueVoicevoxJob(state, "job-a", 1100);
  state = jobs.cancelVoicevoxJobGroup(state, "group-1", 1200);
  assert.equal(state.jobs["job-a"].status, "cancelled");
  assert.equal(state.jobs["job-b"].status, "cancelled");
  assert.equal(state.groups["group-1"].status, "cancelled");
  assert.strictEqual(jobs.cancelVoicevoxJobGroup(state, "group-1", 1300), state);
});

test("counts distinct waiting generations, not A/B jobs", () => {
  let state = register();
  state = jobs.registerVoicevoxJobGroup(state, {
    groupId: "group-2",
    generationId: "generation-2",
    candidates: [
      { candidateId: "candidate-a", jobId: "job-2a" },
      { candidateId: "candidate-b", jobId: "job-2b" },
    ],
    now: 2000,
    expiresAt: 10_000,
  });
  assert.equal(jobs.countWaitingVoicevoxGenerations(state), 2);
  state = jobs.enqueueVoicevoxJob(state, "job-a", 2100);
  state = jobs.acquireVoicevoxLease(state, { jobId: "job-a", leaseId: "lease-a", backend: "vpc", now: 2200 });
  assert.equal(jobs.countWaitingVoicevoxGenerations(state), 2);
  state = jobs.cancelVoicevoxJobGroup(state, "group-2", 2300);
  assert.equal(jobs.countWaitingVoicevoxGenerations(state), 1);
});

test("scheduler returns an explicit backend value", () => {
  assert.equal(jobs.selectVoicevoxBackend({ waitingGenerations: 0 }), "vpc");
  assert.equal(jobs.selectVoicevoxBackend({ waitingGenerations: 2 }), "cloud-run");
  assert.equal(jobs.selectVoicevoxBackend({ waitingGenerations: 2, cloudRunAvailable: false }), "vpc");
  assert.equal(jobs.selectVoicevoxBackend({ waitingGenerations: 0, vpcAvailable: false }), "cloud-run");
  assert.throws(() => jobs.selectVoicevoxBackend({ waitingGenerations: 0, vpcAvailable: false, cloudRunAvailable: false }), (error) => error.code === "invalid-input");
});
