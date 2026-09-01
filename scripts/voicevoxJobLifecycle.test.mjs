import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  optimizeDeps: { noDiscovery: true },
});
const lifecycle = await vite.ssrLoadModule("/src/voicevoxJobLifecycle.ts");
const dispatcher = await vite.ssrLoadModule("/src/voicevoxJobDispatcher.ts");
await vite.close();
const isRead = (query) => /^\s*(?:\/\*[\s\S]*?\*\/\s*)*SELECT\b/i.test(query);
class Statement {
  constructor(database, query, values = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }
  bind(...values) {
    return new Statement(this.database, this.query, values);
  }
  async all() {
    return {
      success: true,
      results: this.database.prepare(this.query).all(...this.values),
      meta: {},
    };
  }
  execute() {
    const statement = this.database.prepare(this.query);
    if (isRead(this.query))
      return {
        success: true,
        results: statement.all(...this.values),
        meta: {},
      };
    const run = statement.run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(run.changes) },
    };
  }
}
class D1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec("PRAGMA foreign_keys = ON");
  }
  async migrate() {
    for (const name of [
      "0003_voicevox_grants.sql",
      "0004_voicevox_jobs.sql",
      "0005_voicevox_job_dispatch.sql",
    ])
      this.database.exec(
        await readFile(
          new URL("../migrations/" + name, import.meta.url),
          "utf8",
        ),
      );
  }
  prepare(query) {
    return new Statement(this.database, query);
  }
  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  rows(query, ...values) {
    return this.database
      .prepare(query)
      .all(...values)
      .map((value) => ({ ...value }));
  }
}
const setup = async ({ expiresAt = 1_000_000 } = {}) => {
  const db = new D1();
  await db.migrate();
  db.database
    .prepare(
      "INSERT INTO voicevox_job_groups (group_id, generation_id, status, created_at, updated_at, expires_at) VALUES ('g', 'gen', 'accepted', 1, 1, ?)",
    )
    .run(expiresAt);
  for (const candidate of ["candidate-a", "candidate-b"])
    db.database
      .prepare(
        "INSERT INTO voicevox_jobs (job_id, group_id, generation_id, candidate_id, idempotency_key, status, attempt, max_attempts, backend, created_at, updated_at, expires_at) VALUES (?, 'g', 'gen', ?, ?, 'accepted', 0, 2, 'vpc', 1, 1, ?)",
      )
      .run(candidate, candidate, `gen:${candidate}`, expiresAt);
  return db;
};

test("claim fences the attempt and lease, and a stale completion cannot overwrite it", async () => {
  const db = await setup();
  const claim = await lifecycle.claimVoicevoxJob(db, {
    jobId: "candidate-a",
    leaseId: "lease-1",
    attempt: 1,
    backend: "vpc",
    now: 10,
    leaseExpiresAt: 100,
  });
  assert.equal(claim.outcome, "applied");
  assert.equal(claim.group.status, "running");
  const duplicate = await lifecycle.claimVoicevoxJob(db, {
    jobId: "candidate-a",
    leaseId: "lease-1",
    attempt: 1,
    backend: "vpc",
    now: 11,
    leaseExpiresAt: 101,
  });
  assert.equal(duplicate.outcome, "duplicate");
  const stale = await lifecycle.completeVoicevoxJob(db, {
    jobId: "candidate-a",
    leaseId: "wrong",
    attempt: 1,
    resultRef: "r2/key",
    resultExpiresAt: 900,
    now: 12,
  });
  assert.equal(stale.outcome, "stale-consumer");
  const completed = await lifecycle.completeVoicevoxJob(db, {
    jobId: "candidate-a",
    leaseId: "lease-1",
    attempt: 1,
    resultRef: "r2/key",
    resultExpiresAt: 900,
    now: 13,
  });
  assert.equal(completed.outcome, "applied");
  assert.equal(completed.job.status, "succeeded");
  assert.equal(completed.group.status, "accepted");
});

test("retry exhausts attempts, cancellation is terminal, and group status is recomputed atomically", async () => {
  const db = await setup();
  await lifecycle.claimVoicevoxJob(db, {
    jobId: "candidate-a",
    leaseId: "l1",
    attempt: 1,
    backend: "vpc",
    now: 10,
    leaseExpiresAt: 100,
  });
  const retry = await lifecycle.failVoicevoxJob(db, {
    jobId: "candidate-a",
    leaseId: "l1",
    attempt: 1,
    errorCode: "upstream-timeout",
    retryable: true,
    now: 11,
  });
  assert.equal(retry.job.status, "queued");
  assert.equal(retry.group.status, "queued");
  await lifecycle.claimVoicevoxJob(db, {
    jobId: "candidate-a",
    leaseId: "l2",
    attempt: 2,
    backend: "vpc",
    now: 20,
    leaseExpiresAt: 100,
  });
  const exhausted = await lifecycle.failVoicevoxJob(db, {
    jobId: "candidate-a",
    leaseId: "l2",
    attempt: 2,
    errorCode: "upstream-timeout",
    retryable: true,
    now: 21,
  });
  assert.equal(exhausted.job.status, "failed");
  const cancelled = await lifecycle.cancelVoicevoxJob(db, {
    jobId: "candidate-b",
    now: 22,
  });
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(cancelled.group.status, "failed");
  const duplicate = await lifecycle.cancelVoicevoxJob(db, {
    jobId: "candidate-b",
    now: 23,
  });
  assert.equal(duplicate.outcome, "duplicate");
});

test("expired leases requeue once, then expire jobs without deleting result metadata", async () => {
  const db = await setup({ expiresAt: 1000 });
  await lifecycle.claimVoicevoxJob(db, {
    jobId: "candidate-a",
    leaseId: "l1",
    attempt: 1,
    backend: "vpc",
    now: 10,
    leaseExpiresAt: 20,
  });
  const first = await lifecycle.recoverExpiredVoicevoxJobs(db, { now: 20 });
  assert.equal(first[0].job.status, "queued");
  assert.equal(first[0].job.errorCode, "lease-expired");
  const second = await lifecycle.recoverExpiredVoicevoxJobs(db, { now: 1000 });
  assert.equal(second[0].job.status, "failed");
  assert.equal(second[0].job.errorCode, "job-expired");
  assert.equal(
    db.rows("SELECT count(*) AS count FROM voicevox_jobs")[0].count,
    2,
  );
});

test("the accepted/queued rows act as a redispatchable outbox after Queue.send", async () => {
  const db = await setup();
  assert.deepEqual(
    (
      await lifecycle.listVoicevoxRedispatchableJobs(db, {
        now: 10,
        staleAfterMs: 50,
        limit: 10,
      })
    ).map((job) => job.jobId),
    ["candidate-a", "candidate-b"],
  );
  const reserved = await lifecycle.claimVoicevoxJobDispatch(db, {
    jobId: "candidate-a",
    dispatchLeaseId: "d1",
    now: 10,
    leaseExpiresAt: 20,
  });
  assert.equal(reserved.outcome, "applied");
  assert.equal(
    (
      await lifecycle.listVoicevoxRedispatchableJobs(db, {
        now: 11,
        staleAfterMs: 50,
        limit: 10,
      })
    ).some((job) => job.jobId === "candidate-a"),
    false,
  );
  const marked = await lifecycle.markVoicevoxJobDispatched(db, {
    jobId: "candidate-a",
    dispatchLeaseId: "d1",
    now: 12,
  });
  assert.equal(marked.outcome, "applied");
  assert.equal(marked.job.status, "queued");
  assert.equal(
    (
      await lifecycle.listVoicevoxRedispatchableJobs(db, {
        now: 12,
        staleAfterMs: 50,
        limit: 10,
      })
    ).some((job) => job.jobId === "candidate-a"),
    false,
  );
  assert.equal(
    (
      await lifecycle.listVoicevoxRedispatchableJobs(db, {
        now: 70,
        staleAfterMs: 50,
        limit: 10,
      })
    ).some((job) => job.jobId === "candidate-a"),
    true,
  );
});

test("older timestamps leave the current lease and updated_at unchanged", async () => {
  const db = await setup();
  await lifecycle.claimVoicevoxJob(db, {
    jobId: "candidate-a",
    leaseId: "lease-1",
    attempt: 1,
    backend: "vpc",
    now: 10,
    leaseExpiresAt: 100,
  });
  const stale = await lifecycle.failVoicevoxJob(db, {
    jobId: "candidate-a",
    leaseId: "lease-1",
    attempt: 1,
    errorCode: "upstream-timeout",
    retryable: true,
    now: 9,
  });
  assert.equal(stale.outcome, "stale-consumer");
  assert.deepEqual(
    db.rows(
      "SELECT status, current_lease_id, updated_at FROM voicevox_jobs WHERE job_id = 'candidate-a'",
    ),
    [{ status: "running", current_lease_id: "lease-1", updated_at: 10 }],
  );
});

test("a stale list cannot acquire a second dispatch after the first sender marked it", async () => {
  const db = await setup();
  const listed = await lifecycle.listVoicevoxRedispatchableJobs(db, {
    now: 10,
    staleAfterMs: 50,
    limit: 10,
  });
  const jobId = listed[0].jobId;
  await lifecycle.claimVoicevoxJobDispatch(db, {
    jobId,
    dispatchLeaseId: "winner",
    now: 10,
    leaseExpiresAt: 30,
    staleAfterMs: 50,
  });
  await lifecycle.markVoicevoxJobDispatched(db, {
    jobId,
    dispatchLeaseId: "winner",
    now: 11,
  });
  const stale = await lifecycle.claimVoicevoxJobDispatch(db, {
    jobId,
    dispatchLeaseId: "late-list",
    now: 12,
    leaseExpiresAt: 40,
    staleAfterMs: 50,
  });
  assert.equal(stale.outcome, "not-claimable");
  assert.equal(stale.job.dispatchLeaseId, null);
  assert.equal(stale.job.dispatchedAt, 11);
  const recovered = await lifecycle.claimVoicevoxJobDispatch(db, {
    jobId,
    dispatchLeaseId: "recovery",
    now: 61,
    leaseExpiresAt: 90,
    staleAfterMs: 50,
  });
  assert.equal(recovered.outcome, "applied");
});

test("real SQLite dispatcher recovers an ambiguous send without allowing mark to regress a running job", async () => {
  const db = await setup();
  const repository = dispatcher.voicevoxDispatchRepository(db);
  const first = await dispatcher.dispatchVoicevoxJobs(
    repository,
    {
      vpc: { send: async () => {
        throw new Error("transport failed");
      } }, "cloud-run": { send: async () => {} },
    },
    { limit: 1, now: () => 10, newLeaseId: () => "dispatch-1" },
  );
  assert.deepEqual(first, {
    scanned: 1,
    sent: 0,
    marked: 0,
    skipped: 0,
    failed: 1,
  });
  assert.equal(
    db.rows(
      "SELECT dispatch_lease_id FROM voicevox_jobs WHERE job_id = 'candidate-a'",
    )[0].dispatch_lease_id,
    "dispatch-1",
  );
  const sent = [];
  const second = await dispatcher.dispatchVoicevoxJobs(
    repository,
    {
      vpc: { send: async (message) => {
        sent.push(message);
      } }, "cloud-run": { send: async () => {} },
    },
    { limit: 1, now: () => 30_011, newLeaseId: () => "dispatch-2" },
  );
  assert.deepEqual(second, {
    scanned: 1,
    sent: 1,
    marked: 1,
    skipped: 0,
    failed: 0,
  });
  assert.equal(sent[0].jobId, "candidate-b");
  assert.equal(
    db.rows(
      "SELECT status, dispatched_at FROM voicevox_jobs WHERE job_id = 'candidate-b'",
    )[0].status,
    "queued",
  );
  const third = await dispatcher.dispatchVoicevoxJobs(
    repository,
    {
      vpc: { send: async (message) => {
        sent.push(message);
      } }, "cloud-run": { send: async () => {} },
    },
    { limit: 1, now: () => 600_020, newLeaseId: () => "dispatch-3" },
  );
  assert.deepEqual(third, {
    scanned: 1,
    sent: 1,
    marked: 1,
    skipped: 0,
    failed: 0,
  });
  assert.equal(sent[1].jobId, "candidate-a");

  const raceDb = await setup();
  await lifecycle.claimVoicevoxJobDispatch(raceDb, {
    jobId: "candidate-b",
    dispatchLeaseId: "dispatch-b",
    now: 40,
    leaseExpiresAt: 90,
  });
  await lifecycle.claimVoicevoxJob(raceDb, {
    jobId: "candidate-b",
    leaseId: "run-b",
    attempt: 1,
    backend: "vpc",
    now: 41,
    leaseExpiresAt: 80,
  });
  const staleMark = await lifecycle.markVoicevoxJobDispatched(raceDb, {
    jobId: "candidate-b",
    dispatchLeaseId: "dispatch-b",
    now: 42,
  });
  assert.equal(staleMark.outcome, "stale-consumer");
  assert.equal(
    raceDb.rows(
      "SELECT status FROM voicevox_jobs WHERE job_id = 'candidate-b'",
    )[0].status,
    "running",
  );
});

test("expiry wins over a cancellation at or after the deadline in either order", async () => {
  for (const cleanupFirst of [false, true]) {
    const db = await setup({ expiresAt: 100 });
    if (cleanupFirst) await lifecycle.recoverExpiredVoicevoxJobs(db, { now: 100 });
    const cancelled = await lifecycle.cancelVoicevoxJob(db, { jobId: "candidate-a", now: 100 });
    assert.equal(cancelled.outcome, "expired");
    await lifecycle.recoverExpiredVoicevoxJobs(db, { now: 100 });
    const row = db.rows("SELECT status, error_code FROM voicevox_jobs WHERE job_id='candidate-a'")[0];
    assert.deepEqual(row, { status: "failed", error_code: "job-expired" });
  }
});

test("payload purge is bounded and leaves job metadata and live payloads intact", async () => {
  const db = await setup();
  db.database
    .prepare(
      "INSERT INTO voicevox_job_payloads (job_id, score_json, score_hash, created_at, expires_at) VALUES ('candidate-a', 'old', 'hash-a', 1, 10), ('candidate-b', 'live', 'hash-b', 1, 100)",
    )
    .run();
  assert.equal(
    await lifecycle.purgeExpiredVoicevoxJobPayloads(db, { now: 10, limit: 1 }),
    1,
  );
  assert.deepEqual(
    db.rows("SELECT job_id, score_json FROM voicevox_job_payloads"),
    [{ job_id: "candidate-b", score_json: "live" }],
  );
  assert.equal(
    db.rows("SELECT count(*) AS count FROM voicevox_jobs")[0].count,
    2,
  );
});
