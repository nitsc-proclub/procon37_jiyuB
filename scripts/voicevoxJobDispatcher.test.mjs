import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  optimizeDeps: { noDiscovery: true },
});
const { dispatchVoicevoxJobs } = await vite.ssrLoadModule(
  "/src/voicevoxJobDispatcher.ts",
);
await vite.close();

function fixture(count = 2) {
  let clock = 1000;
  let lease = 0;
  const jobs = Array.from({ length: count }, (_, i) => ({
    jobId: `job-${i}`,
    generationId: "generation",
    candidateId: i % 2 ? "candidate-b" : "candidate-a",
    backend: "vpc",
    status: "accepted",
    expiresAt: 100_000,
  }));
  const events = [];
  const messages = [];
  const repository = {
    list: async () => jobs,
    claim: async (input) => {
      events.push(`claim:${input.jobId}`);
      const job = jobs.find((j) => j.jobId === input.jobId);
      if (job.dispatchLeaseId) return { outcome: "not-claimable", job };
      Object.assign(job, {
        dispatchLeaseId: input.dispatchLeaseId,
        dispatchLeaseExpiresAt: input.leaseExpiresAt,
      });
      return { outcome: "applied", job: { ...job } };
    },
    mark: async (input) => {
      events.push(`mark:${input.jobId}`);
      return { outcome: "applied" };
    },
  };
  const queue = {
    send: async (message) => {
      events.push(`send:${message.jobId}`);
      messages.push(message);
    },
  };
  return {
    jobs,
    repository,
    queues: { vpc: queue, "cloud-run": queue },
    messages,
    events,
    options: { now: () => clock, newLeaseId: () => `lease-${++lease}` },
    tick: (value) => {
      clock = value;
    },
  };
}

test("outbox sends references only, sequentially, before recording delivery", async () => {
  const f = fixture();
  f.jobs[0].scoreJson = "private lyrics";
  const result = await dispatchVoicevoxJobs(f.repository, f.queues, f.options);
  assert.deepEqual(result, {
    scanned: 2,
    sent: 2,
    marked: 2,
    skipped: 0,
    failed: 0,
  });
  assert.deepEqual(f.events, [
    "claim:job-0",
    "send:job-0",
    "mark:job-0",
    "claim:job-1",
    "send:job-1",
    "mark:job-1",
  ]);
  assert.deepEqual(Object.keys(f.messages[0]).sort(), [
    "candidateId",
    "generationId",
    "jobId",
    "schemaVersion",
  ]);
});

test("ambiguous send is not marked, keeps recovery lease, and does not stop next job", async () => {
  const f = fixture();
  f.queues.vpc.send = async (message) => {
    if (message.jobId === "job-0") throw new Error("transport failed");
    f.messages.push(message);
  };
  const result = await dispatchVoicevoxJobs(f.repository, f.queues, f.options);
  assert.equal(result.failed, 1);
  assert.equal(result.sent, 1);
  assert.ok(f.jobs[0].dispatchLeaseId);
  assert.ok(!f.events.includes("mark:job-0"));
});

test("send success followed by D1 failure leaves recovery to redispatch", async () => {
  const f = fixture(1);
  f.repository.mark = async () => {
    throw new Error("D1 unavailable");
  };
  const result = await dispatchVoicevoxJobs(f.repository, f.queues, f.options);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.marked, 0);
  assert.ok(f.jobs[0].dispatchLeaseId);
});

test("competing passes dispatch only the lease winner", async () => {
  const f = fixture(1);
  const results = await Promise.all([
    dispatchVoicevoxJobs(f.repository, f.queues, f.options),
    dispatchVoicevoxJobs(f.repository, f.queues, f.options),
  ]);
  assert.equal(
    results.reduce((n, result) => n + result.sent, 0),
    1,
  );
});

test("does not send when lease expires while acquiring or observing a duplicate", async () => {
  for (const duplicate of [false, true]) {
    const f = fixture(1);
    const claim = f.repository.claim;
    f.repository.claim = async (input) => {
      const result = await claim(input);
      if (duplicate) result.outcome = "duplicate";
      else f.tick(31_001);
      return result;
    };
    assert.equal(
      (await dispatchVoicevoxJobs(f.repository, f.queues, f.options)).sent,
      0,
    );
  }
});

test("bounded scan, input validation, and consumer-before-mark race", async () => {
  const f = fixture(20);
  f.repository.mark = async () => ({ outcome: "stale-consumer" });
  const result = await dispatchVoicevoxJobs(f.repository, f.queues, {
    ...f.options,
    limit: 3,
  });
  assert.equal(result.scanned, 3);
  assert.equal(result.sent, 3);
  assert.equal(result.marked, 0);
  await assert.rejects(
    dispatchVoicevoxJobs(f.repository, f.queues, { limit: 101 }),
  );
  await assert.rejects(
    dispatchVoicevoxJobs(f.repository, f.queues, { now: () => NaN }),
  );
});
