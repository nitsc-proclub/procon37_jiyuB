import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const stateRoot = join(tmpdir(), `voicevox-backend-pool-${process.pid}-${Date.now()}`);
const bundlePath = join(stateRoot, "voicevox-infrastructure-worker.mjs");

await mkdir(stateRoot, { recursive: true });
await build({
  entryPoints: [join(projectRoot, "src", "voicevoxInfrastructureWorker.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["cloudflare:workers"],
});

const workerScript = await readFile(bundlePath, "utf8");

function poolName(backend) {
  return `voicevox-backend-pool:v1:${backend}`;
}

async function createRuntime({ vpcCapacity = "1", cloudRunCapacity = "1" } = {}) {
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    logRequests: false,
    workers: [{
      config: {
        name: "voicevox-infrastructure",
        type: "worker",
        compatibilityDate: "2026-08-08",
        manifest: {
          mainModule: "voicevox-infrastructure-worker.mjs",
          modules: {
            "voicevox-infrastructure-worker.mjs": { type: "esm", contents: workerScript },
          },
        },
        env: {
          VPC_CAPACITY: { type: "text", value: vpcCapacity },
          CLOUD_RUN_CAPACITY: { type: "text", value: cloudRunCapacity },
          VOICEVOX_BACKEND_POOL: {
            type: "durable-object",
            workerName: "voicevox-infrastructure",
            exportName: "VoicevoxBackendPool",
          },
        },
        exports: {
          VoicevoxBackendPool: { type: "durable-object", storage: "sqlite" },
        },
      },
    }],
  });
  const bindings = await mf.getBindings();
  return {
    mf,
    pool(backend) {
      return bindings.VOICEVOX_BACKEND_POOL.getByName(poolName(backend));
    },
  };
}

function acquire(backend, jobId, attempt = 1, ttlMs = 300_000) {
  return { backend, jobId, generationId: `generation-${jobId}`, attempt, ttlMs };
}

test("one runtime pool grants only one concurrent VPC lease", async (t) => {
  const runtime = await createRuntime();
  t.after(async () => {
    await runtime.mf.dispose();
  });
  const pool = runtime.pool("vpc");
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => pool.acquire(acquire("vpc", `job-${index}`))));
  assert.equal(results.filter((result) => result.granted).length, 1);
  assert.equal((await pool.snapshot()).activeLeases.length, 1);
});

test("Cloud Run capacity three grants three leases and admits the next after release", async (t) => {
  const runtime = await createRuntime({ cloudRunCapacity: "3" });
  t.after(async () => {
    await runtime.mf.dispose();
  });
  const pool = runtime.pool("cloud-run");
  // Durable Objects serialize these acquisitions; issue separate RPCs so the
  // Miniflare RPC transport does not share one in-flight stub request.
  const results = [];
  for (let index = 0; index < 4; index += 1) {
    results.push(await pool.acquire(acquire("cloud-run", `cloud-job-${index}`)));
  }
  const granted = results.filter((result) => result.granted);
  assert.equal(granted.length, 3);
  assert.equal((await pool.snapshot()).activeLeases.length, 3);

  const released = await pool.release({
    backend: "cloud-run",
    jobId: granted[0].lease.jobId,
    generationId: granted[0].lease.generationId,
    attempt: granted[0].lease.attempt,
    leaseId: granted[0].lease.leaseId,
  });
  assert.equal(released.released, true);
  assert.equal((await pool.acquire(acquire("cloud-run", "cloud-job-after-release"))).granted, true);
});

test("capacity validation keeps VPC fixed at one and caps Cloud Run at three", async (t) => {
  const vpcRuntime = await createRuntime({ vpcCapacity: "2" });
  const cloudRuntime = await createRuntime({ cloudRunCapacity: "4" });
  t.after(async () => {
    await Promise.all([vpcRuntime.mf.dispose(), cloudRuntime.mf.dispose()]);
  });
  await assert.rejects(vpcRuntime.pool("vpc").acquire(acquire("vpc", "invalid-vpc-capacity")));
  await assert.rejects(cloudRuntime.pool("cloud-run").acquire(acquire("cloud-run", "invalid-cloud-capacity")));
});

test("a matching redelivery reuses its lease and another attempt is fenced", async (t) => {
  const runtime = await createRuntime();
  t.after(async () => {
    await runtime.mf.dispose();
  });
  const pool = runtime.pool("vpc");
  const first = await pool.acquire(acquire("vpc", "job-retry"));
  const replay = await pool.acquire(acquire("vpc", "job-retry"));
  assert.equal(first.granted, true);
  assert.equal(replay.granted, true);
  assert.equal(replay.reused, true);
  assert.equal(replay.lease.leaseId, first.lease.leaseId);
  await assert.rejects(pool.acquire(acquire("vpc", "job-retry", 2)));
});

test("a mismatched release cannot free another consumer's lease", async (t) => {
  const runtime = await createRuntime();
  t.after(async () => {
    await runtime.mf.dispose();
  });
  const pool = runtime.pool("vpc");
  const leased = await pool.acquire(acquire("vpc", "job-release"));
  const released = await pool.release({
    backend: "vpc",
    jobId: "job-release",
    generationId: "generation-job-release",
    attempt: 1,
    leaseId: "wrong-lease",
  });
  assert.equal(released.released, false);
  assert.equal((await pool.snapshot()).activeLeases[0].leaseId, leased.lease.leaseId);
});

test("TTL expiry releases capacity and VPC and Cloud Run remain separate pools", async (t) => {
  const runtime = await createRuntime();
  t.after(async () => {
    await runtime.mf.dispose();
  });
  const vpc = runtime.pool("vpc");
  const cloudRun = runtime.pool("cloud-run");
  const shortLease = await vpc.acquire(acquire("vpc", "job-ttl", 1, 5));
  const cloudLease = await cloudRun.acquire(acquire("cloud-run", "job-cloud"));
  assert.equal(shortLease.granted, true);
  assert.equal(cloudLease.granted, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await vpc.snapshot()).activeLeases.length, 0);
  assert.equal((await vpc.acquire(acquire("vpc", "job-after-ttl"))).granted, true);
  assert.equal((await cloudRun.snapshot()).activeLeases.length, 1);
});

test("the infrastructure worker has no HTTP surface", async (t) => {
  const runtime = await createRuntime();
  t.after(async () => {
    await runtime.mf.dispose();
  });
  const response = await runtime.mf.dispatchFetch("https://voicevox-infra.invalid/anything");
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not Found");
});

test.after(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});
