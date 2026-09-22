import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", optimizeDeps: { noDiscovery: true } });
const repository = await vite.ssrLoadModule("/src/voicevoxJobRepository.ts");
await vite.close();

const hash = (value) => createHash("sha256").update(value).digest("hex");
const isReadQuery = (query) => /^\s*(?:\/\*[\s\S]*?\*\/\s*)*SELECT\b/i.test(query);

class SqliteStatement {
  constructor(database, query, values = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values) {
    return new SqliteStatement(this.database, this.query, values);
  }

  async all() {
    return { success: true, results: this.database.prepare(this.query).all(...this.values), meta: {} };
  }

  execute() {
    const statement = this.database.prepare(this.query);
    if (isReadQuery(this.query)) return { success: true, results: statement.all(...this.values), meta: {} };
    const result = statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec("PRAGMA foreign_keys = ON");
  }

  async migrate() {
    for (const file of ["0003_voicevox_grants.sql", "0004_voicevox_jobs.sql", "0007_voicevox_group_backend.sql"]) {
      this.database.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
    }
  }

  prepare(query) {
    return new SqliteStatement(this.database, query);
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
    return this.database.prepare(query).all(...values).map((row) => ({ ...row }));
  }
}

class AvailabilityRaceD1 {
  constructor(database, pretendAvailableReads = 2) {
    this.database = database;
    this.pretendAvailableReads = pretendAvailableReads;
  }

  prepare(query) {
    if (query.includes("voicevox-job:grant-available") && this.pretendAvailableReads > 0) {
      this.pretendAvailableReads -= 1;
      return { bind: () => ({ all: async () => ({ success: true, results: [{ grant_hash: "stale-read" }], meta: {} }) }) };
    }
    return this.database.prepare(query);
  }

  batch(statements) {
    return this.database.batch(statements);
  }
}

class ReadOnlyBatchD1 {
  constructor(database) {
    this.database = database;
    this.readBatchCount = 0;
  }

  prepare(query) {
    const statement = this.database.prepare(query);
    if (!query.includes("voicevox-job:group-by-generation") && !query.includes("voicevox-job:jobs-by-generation")) return statement;
    return {
      bind: (...values) => {
        const bound = statement.bind(...values);
        return {
          readOnlyGenerationSnapshot: true,
          all: async () => {
            throw new Error("generation reads must use D1 batch");
          },
          execute: () => bound.execute(),
        };
      },
    };
  }

  batch(statements) {
    if (statements.some((statement) => statement.readOnlyGenerationSnapshot)) this.readBatchCount += 1;
    return this.database.batch(statements);
  }
}

const fixture = ({ groupId = randomUUID(), generationId = randomUUID(), now = 1_000, expiresAt = 10_000 } = {}) => {
  const candidates = ["candidate-a", "candidate-b"].map((candidateId) => {
    const scoreJson = JSON.stringify({ candidateId, notes: [60, 62, 64] });
    const rawGrant = generationId + "-" + candidateId;
    return {
      candidateId,
      jobId: generationId + "-" + candidateId,
      scoreJson,
      scoreHash: hash(scoreJson),
      grantHash: hash(rawGrant),
    };
  });
  return { request: { groupId, generationId, candidates, now, expiresAt }, candidates };
};

const insertGrants = (database, entry, { issuedAt = 500, expiresAt = entry.request.expiresAt, consumedAt = null, scoreHashes = {} } = {}) => {
  for (const candidate of entry.candidates) {
    database.database.prepare(
      "INSERT INTO voicevox_grants (grant_hash, generation_id, candidate_id, issued_at, expires_at, consumed_at, score_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(candidate.grantHash, entry.request.generationId, candidate.candidateId, issuedAt, expiresAt, consumedAt, scoreHashes[candidate.candidateId] ?? null);
  }
};

const createDatabase = async () => {
  const database = new SqliteD1();
  await database.migrate();
  return database;
};

test("real SQLite batch registers both candidates, exact payloads, and a matching retry is a no-op", async () => {
  const database = await createDatabase();
  const entry = fixture();
  insertGrants(database, entry);

  const first = await repository.registerVoicevoxJobs(database, entry.request);
  const second = await repository.registerVoicevoxJobs(database, entry.request);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(database.rows("SELECT * FROM voicevox_job_groups").length, 1);
  assert.equal(database.rows("SELECT * FROM voicevox_jobs").length, 2);
  assert.equal(database.rows("SELECT * FROM voicevox_job_payloads").length, 2);
  assert.deepEqual(database.rows("SELECT preferred_backend FROM voicevox_job_groups"), [{ preferred_backend: "vpc" }]);
  assert.deepEqual(database.rows("SELECT backend FROM voicevox_jobs ORDER BY candidate_id"), [{ backend: "vpc" }, { backend: "vpc" }]);
  assert.deepEqual(
    database.rows("SELECT candidate_id, consumed_at, score_hash FROM voicevox_grants ORDER BY candidate_id"),
    entry.candidates.map((candidate) => ({ candidate_id: candidate.candidateId, consumed_at: entry.request.now, score_hash: candidate.scoreHash })),
  );
  assert.deepEqual(second.jobs.map(({ scoreJson, scoreHash }) => ({ scoreJson, scoreHash })), entry.candidates.map(({ scoreJson, scoreHash }) => ({ scoreJson, scoreHash })));
});

test("the third overlapping generation is fixed to cloud-run, while the first two stay on VPC", async () => {
  const database = await createDatabase();
  const first = fixture(); const second = fixture(); const third = fixture();
  for (const entry of [first, second, third]) insertGrants(database, entry);
  await repository.registerVoicevoxJobs(database, first.request);
  await repository.registerVoicevoxJobs(database, second.request);
  const result = await repository.registerVoicevoxJobs(database, third.request);
  assert.equal(result.group.preferredBackend, "cloud-run");
  assert.deepEqual(result.jobs.map((job) => job.backend), ["cloud-run", "cloud-run"]);
});

test("an expired or not-yet-issued grant cannot create a partial group or consume either grant", async () => {
  const database = await createDatabase();
  const entry = fixture();
  insertGrants(database, entry, { issuedAt: entry.request.now + 1 });

  await assert.rejects(repository.registerVoicevoxJobs(database, entry.request), (error) => error.code === "grant-invalid");

  assert.equal(database.rows("SELECT * FROM voicevox_job_groups").length, 0);
  assert.equal(database.rows("SELECT * FROM voicevox_jobs").length, 0);
  assert.deepEqual(database.rows("SELECT consumed_at, score_hash FROM voicevox_grants"), [
    { consumed_at: null, score_hash: null },
    { consumed_at: null, score_hash: null },
  ]);
});

test("a same-millisecond prior consumption cannot pass the in-batch grant guard", async () => {
  const database = await createDatabase();
  const entry = fixture();
  insertGrants(database, entry, {
    consumedAt: entry.request.now,
    scoreHashes: Object.fromEntries(entry.candidates.map((candidate) => [candidate.candidateId, candidate.scoreHash])),
  });
  const racedDatabase = new AvailabilityRaceD1(database);

  await assert.rejects(repository.registerVoicevoxJobs(racedDatabase, entry.request), (error) => error.code === "grant-invalid");

  assert.equal(database.rows("SELECT * FROM voicevox_job_groups").length, 0);
  assert.equal(database.rows("SELECT * FROM voicevox_jobs").length, 0);
  assert.equal(database.rows("SELECT * FROM voicevox_job_payloads").length, 0);
});

test("a later job constraint failure rolls back the group and both grant consumptions", async () => {
  const database = await createDatabase();
  const entry = fixture();
  insertGrants(database, entry);
  const conflictingGroupId = randomUUID();
  const conflictingGenerationId = randomUUID();
  const conflictingJobId = entry.candidates[0].jobId;
  database.database.prepare(
    "INSERT INTO voicevox_job_groups (group_id, generation_id, status, created_at, updated_at, expires_at) VALUES (?, ?, 'accepted', ?, ?, ?)",
  ).run(conflictingGroupId, conflictingGenerationId, 10, 10, 20_000);
  database.database.prepare(
    "INSERT INTO voicevox_jobs (job_id, group_id, generation_id, candidate_id, idempotency_key, status, attempt, max_attempts, created_at, updated_at, expires_at) VALUES (?, ?, ?, 'candidate-a', ?, 'accepted', 0, 3, 10, 10, 20000)",
  ).run(conflictingJobId, conflictingGroupId, conflictingGenerationId, conflictingGenerationId + ":candidate-a");

  await assert.rejects(repository.registerVoicevoxJobs(database, entry.request), (error) => error.code === "storage-failed");

  assert.equal(database.rows("SELECT * FROM voicevox_job_groups WHERE generation_id = ?", entry.request.generationId).length, 0);
  assert.equal(database.rows("SELECT * FROM voicevox_jobs WHERE generation_id = ?", entry.request.generationId).length, 0);
  assert.deepEqual(database.rows("SELECT consumed_at, score_hash FROM voicevox_grants ORDER BY candidate_id"), [
    { consumed_at: null, score_hash: null },
    { consumed_at: null, score_hash: null },
  ]);
});

test("a changed score or group identifier for the same generation is an idempotency conflict", async () => {
  const database = await createDatabase();
  const entry = fixture();
  insertGrants(database, entry);
  await repository.registerVoicevoxJobs(database, entry.request);

  const changedScore = structuredClone(entry.request);
  changedScore.candidates[0].scoreJson = JSON.stringify({ candidateId: "candidate-a", notes: [1] });
  changedScore.candidates[0].scoreHash = hash(changedScore.candidates[0].scoreJson);
  await assert.rejects(repository.registerVoicevoxJobs(database, changedScore), (error) => error.code === "idempotency-conflict");

  const changedGroup = { ...entry.request, groupId: randomUUID() };
  await assert.rejects(repository.registerVoicevoxJobs(database, changedGroup), (error) => error.code === "idempotency-conflict");
});

test("score hashes must describe the exact serialized score", async () => {
  const database = await createDatabase();
  const entry = fixture();
  insertGrants(database, entry);
  entry.request.candidates[0].scoreHash = hash("different");

  await assert.rejects(repository.registerVoicevoxJobs(database, entry.request), (error) => error.code === "invalid-input");
  assert.equal(database.rows("SELECT * FROM voicevox_job_groups").length, 0);
  assert.equal(database.rows("SELECT consumed_at FROM voicevox_grants WHERE consumed_at IS NOT NULL").length, 0);
});

test("excessive attempt caps are rejected before consuming grants", async () => {
  const database = await createDatabase();
  const entry = fixture();
  insertGrants(database, entry);
  await assert.rejects(repository.registerVoicevoxJobs(database, { ...entry.request, maxAttempts: 6 }), (error) => error.code === "invalid-input");
  assert.equal(database.rows("SELECT COUNT(*) AS n FROM voicevox_grants WHERE consumed_at IS NOT NULL")[0].n, 0);
  assert.equal(database.rows("SELECT COUNT(*) AS n FROM voicevox_jobs")[0].n, 0);
});

test("group and job reads use one read-only batch, never independent selects", async () => {
  const database = await createDatabase();
  const entry = fixture();
  insertGrants(database, entry);
  const batchedDatabase = new ReadOnlyBatchD1(database);

  await repository.registerVoicevoxJobs(batchedDatabase, entry.request);

  assert.equal(batchedDatabase.readBatchCount, 2);
});

test("registration snapshots caller input before awaiting the score hash", async () => {
  const database = await createDatabase();
  const entry = fixture();
  insertGrants(database, entry);
  const expectedScoreJson = entry.request.candidates[0].scoreJson;
  const expectedGroupId = entry.request.groupId;

  const registered = repository.registerVoicevoxJobs(database, entry.request);
  entry.request.candidates[0].scoreJson = JSON.stringify({ candidateId: "candidate-a", notes: [1] });
  entry.request.candidates[0].scoreHash = hash(entry.request.candidates[0].scoreJson);
  entry.request.groupId = randomUUID();

  const result = await registered;
  assert.equal(result.group.groupId, expectedGroupId);
  assert.equal(result.jobs[0].scoreJson, expectedScoreJson);
  assert.equal(database.rows("SELECT score_json FROM voicevox_job_payloads WHERE job_id = ?", result.jobs[0].jobId)[0].score_json, expectedScoreJson);
});


test("one candidate uses one grant and retry cannot change candidate count", async () => {
  const database = await createDatabase();
  const entry = fixture();
  insertGrants(database, entry);
  const single = { ...entry.request, candidates: entry.candidates.slice(0, 1) };
  const first = await repository.registerVoicevoxJobs(database, single);
  assert.equal(first.jobs.length, 1);
  assert.equal(first.group.jobIds.length, 1);
  assert.equal((await repository.registerVoicevoxJobs(database, single)).created, false);
  assert.equal(database.rows("SELECT * FROM voicevox_grants WHERE consumed_at IS NOT NULL").length, 1);
  await assert.rejects(repository.registerVoicevoxJobs(database, entry.request), e => e.code === "idempotency-conflict");
});
