import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
  appType: "custom",
});
const temporary = await vite.ssrLoadModule("/src/voicevoxTemporaryAudio.ts");
const leaseId = "5d131e17-4b65-4a9d-9c99-9e627aef5d7a";
const scope = () => ({ jobId: "job/one", attempt: 1, leaseId });
const pcmWav = () => {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  bytes.set([82, 73, 70, 70], 0);
  view.setUint32(4, 36, true);
  bytes.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set([100, 97, 116, 97], 36);
  view.setUint32(40, 0, true);
  return bytes;
};

class MemoryR2 {
  objects = new Map();
  failAfterWavDelete = false;
  async put(key, value, options = {}) {
    const bytes =
      value instanceof Uint8Array
        ? value
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, options });
    return { key, size: bytes.byteLength };
  }
  async get(key) {
    const entry = this.objects.get(key);
    return entry
      ? {
          key,
          size: entry.bytes.byteLength,
          body: new ReadableStream({
            start(c) {
              c.enqueue(entry.bytes);
              c.close();
            },
          }),
        }
      : null;
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.failAfterWavDelete && key.includes("metadata/"))
        throw new Error("injected metadata delete failure");
      this.objects.delete(key);
    }
  }
  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    const start = cursor ? keys.findIndex((key) => key > cursor) : 0;
    const page = keys.slice(start, start + limit);
    return {
      objects: page.map((key) => ({
        key,
        size: this.objects.get(key).bytes.byteLength,
      })),
      truncated: start + page.length < keys.length,
      cursor: start + page.length < keys.length ? page.at(-1) : undefined,
    };
  }
}

test("actual job/attempt/lease scope creates private WAV data and validates full PCM RIFF", async () => {
  const bucket = new MemoryR2();
  const stored = await temporary.storeTemporaryVoicevoxWav(
    bucket,
    scope(),
    pcmWav(),
    { now: 1_000 },
  );
  const wavKey = [...bucket.objects.keys()].find((key) => key.endsWith(".wav"));
  assert.match(
    wavKey,
    /^wav\/v1\/audio\/6a6f622f6f6e65\/1\/5d131e17-4b65-4a9d-9c99-9e627aef5d7a\//,
  );
  assert.equal(
    bucket.objects.get(wavKey).options.customMetadata.sha256,
    stored.sha256,
  );
  const response = await temporary.readTemporaryVoicevoxWav(
    bucket,
    stored.audioId,
    1_001,
  );
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(
    [...new Uint8Array(await response.arrayBuffer())],
    [...pcmWav()],
  );
  const unicode = await temporary.storeTemporaryVoicevoxWav(
    bucket,
    { ...scope(), jobId: "歌" },
    pcmWav(),
    { now: 1_000 },
  );
  assert.equal(
    [...bucket.objects.keys()].some((key) =>
      key.includes(`/e6ad8c/1/${leaseId}/${unicode.audioId}.wav`),
    ),
    true,
  );
});

test("bad input, null R2 writes, cross-referenced metadata, expiry, and body length mismatches fail closed", async () => {
  const bucket = new MemoryR2();
  await assert.rejects(
    temporary.storeTemporaryVoicevoxWav(
      bucket,
      { ...scope(), attempt: 0 },
      pcmWav(),
    ),
    (error) => error.code === "invalid-input",
  );
  await assert.rejects(
    temporary.storeTemporaryVoicevoxWav(
      bucket,
      { ...scope(), jobId: "job id" },
      pcmWav(),
    ),
    (error) => error.code === "invalid-input",
  );
  await assert.rejects(
    temporary.storeTemporaryVoicevoxWav(
      bucket,
      { ...scope(), leaseId: "not-a-lease" },
      pcmWav(),
    ),
    (error) => error.code === "invalid-input",
  );
  await assert.rejects(
    temporary.storeTemporaryVoicevoxWav(bucket, scope(), new Uint8Array(44)),
    (error) => error.code === "invalid-wav",
  );
  await assert.rejects(
    temporary.storeTemporaryVoicevoxWav(
      bucket,
      scope(),
      new ReadableStream({
        start(c) {
          c.enqueue(pcmWav());
          c.enqueue(new Uint8Array(temporary.TEMPORARY_AUDIO_MAX_BYTES));
          c.close();
        },
      }),
    ),
    (error) => error.code === "audio-too-large",
  );
  const rejecting = new MemoryR2();
  rejecting.put = async () => null;
  await assert.rejects(
    temporary.storeTemporaryVoicevoxWav(rejecting, scope(), pcmWav()),
    (error) => error.code === "storage-failed",
  );
  const stored = await temporary.storeTemporaryVoicevoxWav(
    bucket,
    scope(),
    pcmWav(),
    { now: 1_000, ttlSeconds: 1 },
  );
  await assert.rejects(
    temporary.readTemporaryVoicevoxWav(bucket, stored.audioId, 2_000),
    (error) => error.code === "expired",
  );
  const metaKey = `wav/v1/metadata/${stored.audioId}.json`;
  const metadata = JSON.parse(
    new TextDecoder().decode(bucket.objects.get(metaKey).bytes),
  );
  metadata.audioId = crypto.randomUUID();
  bucket.objects.get(metaKey).bytes = new TextEncoder().encode(
    JSON.stringify(metadata),
  );
  await assert.rejects(
    temporary.readTemporaryVoicevoxWav(bucket, stored.audioId, 1_001),
    (error) => error.code === "corrupt-metadata",
  );
});

test("cleanup resumes with a cursor, scans at most 100 metadata objects, and retains metadata when WAV deletion is only partially complete", async () => {
  const bucket = new MemoryR2();
  const first = await temporary.storeTemporaryVoicevoxWav(
    bucket,
    scope(),
    pcmWav(),
    { now: 1_000, ttlSeconds: 1 },
  );
  const second = await temporary.storeTemporaryVoicevoxWav(
    bucket,
    { ...scope(), attempt: 2 },
    pcmWav(),
    { now: 1_000, ttlSeconds: 1 },
  );
  await bucket.put("archive/never-delete.wav", pcmWav());
  bucket.failAfterWavDelete = true;
  const failed = await temporary.cleanupExpiredTemporaryVoicevoxAudio(bucket, {
    now: 2_000,
    objectBudget: 1,
  });
  assert.equal(failed.scanned, 1);
  assert.equal(failed.deleted, 1);
  assert.equal(failed.failed, 1);
  assert.equal(
    bucket.objects.has(`wav/v1/metadata/${first.audioId}.json`),
    true,
  );
  assert.equal(bucket.objects.has("archive/never-delete.wav"), true);
  bucket.failAfterWavDelete = false;
  const cleaned = await temporary.cleanupExpiredTemporaryVoicevoxAudio(bucket, {
    now: 2_000,
    objectBudget: 100,
  });
  assert.equal(cleaned.deleted, 4);
  assert.equal(
    bucket.objects.has(`wav/v1/metadata/${first.audioId}.json`),
    false,
  );
  assert.equal(
    bucket.objects.has(`wav/v1/metadata/${second.audioId}.json`),
    false,
  );
  assert.equal(bucket.objects.has("archive/never-delete.wav"), true);
});

test("temporary TTL bounds and RIFF truncation are rejected before writing", async () => {
  const bucket = new MemoryR2();
  for (const options of [{ now: -1 }, { now: Number.MAX_SAFE_INTEGER }, { ttlSeconds: 0 }, { ttlSeconds: 86_401 }]) {
    await assert.rejects(temporary.storeTemporaryVoicevoxWav(bucket, scope(), pcmWav(), options), (error) => error.code === "invalid-input");
  }
  const truncated = pcmWav();
  new DataView(truncated.buffer).setUint32(40, 100, true);
  await assert.rejects(temporary.storeTemporaryVoicevoxWav(bucket, scope(), truncated), (error) => error.code === "invalid-wav");
  assert.equal(bucket.objects.size, 0);
});

test("short and overlong stored streams cannot silently complete delivery", async () => {
  for (const length of [43, 45]) {
    const bucket = new MemoryR2();
    const saved = await temporary.storeTemporaryVoicevoxWav(bucket, scope(), pcmWav(), { now: 1_000 });
    const get = bucket.get.bind(bucket);
    bucket.get = async (key) => {
      const object = await get(key);
      if (!key.endsWith(".wav")) return object;
      await object.body.cancel();
      return { ...object, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(length)); c.close(); } }) };
    };
    const response = await temporary.readTemporaryVoicevoxWav(bucket, saved.audioId, 1_001);
    await assert.rejects(response.arrayBuffer(), (error) => error.code === "corrupt-metadata");
  }
});

test("a failed metadata write never reports success; lifecycle covers orphan WAV", async () => {
  const bucket = new MemoryR2();
  const put = bucket.put.bind(bucket);
  bucket.put = async (key, value, options) => key.includes("/metadata/") ? null : put(key, value, options);
  await assert.rejects(temporary.storeTemporaryVoicevoxWav(bucket, scope(), pcmWav()), (error) => error.code === "storage-failed");
  assert.equal(bucket.objects.size, 1);
  assert.match([...bucket.objects.keys()][0], /^wav\//);
});

test("cleanup cursor resumes without skipping remaining expired files", async () => {
  const bucket = new MemoryR2();
  for (let i = 0; i < 3; i++) await temporary.storeTemporaryVoicevoxWav(bucket, scope(), pcmWav(), { now: 1_000, ttlSeconds: 1 });
  let cursor;
  let deleted = 0;
  for (let i = 0; i < 3; i++) {
    const result = await temporary.cleanupExpiredTemporaryVoicevoxAudio(bucket, { now: 2_000, cursor, objectBudget: 1, pageSize: 1 });
    assert.equal(result.scanned, 1);
    deleted += result.deleted;
    cursor = result.nextCursor;
  }
  assert.equal(cursor, undefined);
  assert.equal(deleted, 6);
  assert.equal(bucket.objects.size, 0);
});

const root = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = join(
  tmpdir(),
  `temporary-audio-${process.pid}-${Date.now()}`,
);
const workerPath = join(runtimeRoot, "worker.mjs");
await mkdir(runtimeRoot, { recursive: true });
await build({
  stdin: {
    contents: `import { storeTemporaryVoicevoxWav, readTemporaryVoicevoxWav, cleanupExpiredTemporaryVoicevoxAudio } from ${JSON.stringify(join(root, "src/voicevoxTemporaryAudio.ts"))}; const wav = new Uint8Array(${JSON.stringify([...pcmWav()])}); const scope={jobId:'miniflare-job',attempt:1,leaseId:'5d131e17-4b65-4a9d-9c99-9e627aef5d7a'}; export default { async fetch(request, env) { const url=new URL(request.url); if(url.pathname==='/put') return Response.json(await storeTemporaryVoicevoxWav(env.TEMP_AUDIO,scope,wav,{now:1000,ttlSeconds:1})); if(url.pathname==='/read') return readTemporaryVoicevoxWav(env.TEMP_AUDIO,url.searchParams.get('id'),1001); if(url.pathname==='/delete') return Response.json(await cleanupExpiredTemporaryVoicevoxAudio(env.TEMP_AUDIO,{now:2000})); return new Response('no',{status:404}); } };`,
    resolveDir: root,
    loader: "ts",
  },
  outfile: workerPath,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
});
const workerScript = await readFile(workerPath, "utf8");
test("Miniflare R2 binding performs put, get, and delete", async (t) => {
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    workers: [
      {
        config: {
          name: "temporary-audio",
          type: "worker",
          compatibilityDate: "2026-08-08",
          manifest: {
            mainModule: "worker.mjs",
            modules: { "worker.mjs": { type: "esm", contents: workerScript } },
          },
          env: { TEMP_AUDIO: { type: "r2", name: "temporary-audio-test" } },
        },
      },
    ],
  });
  t.after(() => mf.dispose());
  const stored = await (
    await mf.dispatchFetch("https://temporary.invalid/put")
  ).json();
  const read = await mf.dispatchFetch(
    `https://temporary.invalid/read?id=${stored.audioId}`,
  );
  assert.equal(read.status, 200);
  assert.deepEqual(
    [...new Uint8Array(await read.arrayBuffer())],
    [...pcmWav()],
  );
  const clean = await (
    await mf.dispatchFetch("https://temporary.invalid/delete")
  ).json();
  assert.equal(clean.deleted, 2);
  assert.equal(
    (
      await mf.dispatchFetch(
        `https://temporary.invalid/read?id=${stored.audioId}`,
      )
    ).status,
    500,
  );
});
test.after(async () => {
  await vite.close();
  await rm(runtimeRoot, { recursive: true, force: true });
});
