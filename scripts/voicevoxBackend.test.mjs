import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
  appType: "custom",
});
const backend = await vite.ssrLoadModule("/src/voicevoxBackend.ts");
const workerModule = await vite.ssrLoadModule("/src/worker.ts");

const score = {
  notes: [{ lyric: "あ", key: 60, frame_length: 120 }],
};
const cloudRunUrl = "https://voicevox-engine-1023600737600.asia-northeast1.run.app";
const wavBytes = new Uint8Array([82, 73, 70, 70]);

test("score validation and Cloud Run URL validation stay bounded", () => {
  assert.deepEqual(backend.parseSingingScore(score), score);
  assert.throws(
    () => backend.parseSingingScore({ notes: [{ lyric: "あ", key: 60, frame_length: 36_000 }, { lyric: "い", key: 61, frame_length: 1 }] }),
    (error) => error.code === "voice-score-too-long" && error.status === 413,
  );
  assert.equal(backend.getCloudRunUrl({ VOICEVOX_CLOUD_RUN_URL: cloudRunUrl }), cloudRunUrl);
  assert.throws(
    () => backend.getCloudRunUrl({ VOICEVOX_CLOUD_RUN_URL: `${cloudRunUrl}/private` }),
    (error) => error.code === "voice-cloud-run-config" && error.status === 503,
  );
  assert.throws(
    () => backend.parseVoicevoxBackendSelection("public-url"),
    (error) => error.code === "invalid-voice-backend" && error.status === 400,
  );
});

test("auto mode uses VPC first, retries with Cloud Run, and keeps its authorization private", async () => {
  const vpcCalls = [];
  const cloudCalls = [];
  const env = {
    VOICEVOX: {
      fetch: async (resource) => {
        vpcCalls.push(String(resource));
        return new Response("temporarily unavailable", { status: 503 });
      },
    },
    VOICEVOX_CLOUD_RUN_URL: cloudRunUrl,
    VOICEVOX_GCP_SERVICE_ACCOUNT_JSON: "test-service-account",
  };
  assert.deepEqual(backend.getVoicevoxBackendOrder(env, "auto"), ["vpc", "cloud-run"]);
  assert.deepEqual(backend.getVoicevoxBackendOrder(env, "vpc"), ["vpc"]);

  const result = await backend.synthesizeWithVoicevoxFallback(env, "auto", score, {
    createIdToken: async (serviceAccountJson, audience) => {
      assert.equal(serviceAccountJson, "test-service-account");
      assert.equal(audience, cloudRunUrl);
      return "test-id-token";
    },
    fetcher: async (resource, init) => {
      const url = String(resource);
      cloudCalls.push({ url, init });
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-id-token");
      if (url.includes("/sing_frame_audio_query")) return new Response(JSON.stringify({ outputSamplingRate: 24_000 }));
      if (url.includes("/frame_synthesis")) return new Response(wavBytes, { headers: { "Content-Length": String(wavBytes.byteLength) } });
      assert.fail(`Unexpected Cloud Run request: ${url}`);
    },
  });

  assert.equal(result.backend, "cloud-run");
  assert.equal(result.fallback, true);
  assert.deepEqual([...new Uint8Array(await result.response.arrayBuffer())], [...wavBytes]);
  assert.deepEqual(vpcCalls, ["http://localhost:50021/sing_frame_audio_query?speaker=6000"]);
  assert.deepEqual(cloudCalls.map((call) => call.url), [
    `${cloudRunUrl}/sing_frame_audio_query?speaker=6000`,
    `${cloudRunUrl}/frame_synthesis?speaker=3003`,
  ]);
});

test("non-retryable responses stop fallback and malformed queries stop synthesis", async () => {
  let cloudRunCalled = false;
  const unavailableVPC = {
    VOICEVOX: { fetch: async () => new Response("bad request", { status: 400 }) },
    VOICEVOX_CLOUD_RUN_URL: cloudRunUrl,
    VOICEVOX_GCP_SERVICE_ACCOUNT_JSON: "test-service-account",
  };
  await assert.rejects(
    backend.synthesizeWithVoicevoxFallback(unavailableVPC, "auto", score, {
      createIdToken: async () => "test-id-token",
      fetcher: async () => {
        cloudRunCalled = true;
        return new Response();
      },
    }),
    (error) => error.code === "voice-query-failed" && error.retryable === false && error.backend === "vpc",
  );
  assert.equal(cloudRunCalled, false);

  let requestCount = 0;
  await assert.rejects(
    backend.synthesizeWithVoicevoxBackend({
      VOICEVOX: {
        fetch: async () => {
          requestCount += 1;
          return new Response("[]");
        },
      },
    }, "vpc", score),
    (error) => error.code === "voice-query-invalid" && error.backend === "vpc",
  );
  assert.equal(requestCount, 1);
});

test("chunked query and audio responses remain bounded without Content-Length", async () => {
  let queryCalls = 0;
  await assert.rejects(
    backend.synthesizeWithVoicevoxBackend({
      VOICEVOX: {
        fetch: async () => {
          queryCalls += 1;
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          }));
        },
      },
    }, "vpc", score),
    (error) => error.code === "voice-query-too-large" && error.retryable === false,
  );
  assert.equal(queryCalls, 1);

  let requestCount = 0;
  const result = await backend.synthesizeWithVoicevoxBackend({
    VOICEVOX: {
      fetch: async () => {
        requestCount += 1;
        if (requestCount === 1) return new Response(JSON.stringify({ outputSamplingRate: 24_000 }));
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024));
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
            controller.close();
          },
        }));
      },
    },
  }, "vpc", score);
  await assert.rejects(
    result.response.arrayBuffer(),
    (error) => error.code === "voice-audio-too-large" && error.retryable === false,
  );
});

test("Worker synthesis and status routes retain same-origin, audio headers, and response bodies", async () => {
  const vpcRequests = [];
  const env = {
    ASSETS: { fetch: async () => new Response("asset") },
    EVALUATIONS_DB: {
      prepare: () => ({
        bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
      }),
    },
    VOICEVOX: {
      fetch: async (resource) => {
        const url = String(resource);
        vpcRequests.push(url);
        if (url.endsWith("/version")) return new Response(JSON.stringify({ version: "0.24.0" }));
        if (url.includes("/sing_frame_audio_query")) return new Response(JSON.stringify({ outputSamplingRate: 24_000 }));
        if (url.includes("/frame_synthesis")) return new Response(wavBytes, { headers: { "Content-Length": String(wavBytes.byteLength) } });
        assert.fail(`Unexpected VPC request: ${url}`);
      },
    },
  };
  const worker = workerModule.default;
  const origin = "https://maker.example";
  const synthesisResponse = await worker.fetch(new Request(`${origin}/api/voicevox/synthesize`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ voiceGrant: "a".repeat(43), score, backend: "vpc" }),
  }), env);
  assert.equal(synthesisResponse.status, 200);
  assert.equal(synthesisResponse.headers.get("Content-Type"), "audio/wav");
  assert.equal(synthesisResponse.headers.get("Cache-Control"), "no-store");
  assert.equal(synthesisResponse.headers.get("X-Voicevox-Backend"), "vpc");
  assert.equal(synthesisResponse.headers.get("X-Voicevox-Fallback"), "false");
  assert.deepEqual([...new Uint8Array(await synthesisResponse.arrayBuffer())], [...wavBytes]);

  const statusResponse = await worker.fetch(new Request(`${origin}/api/voicevox/status?backend=vpc`, {
    headers: { Origin: origin },
  }), env);
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).version, "0.24.0");
  const cloudStatus = await worker.fetch(new Request(`${origin}/api/voicevox/status?backend=cloud-run`, {
    headers: { Origin: origin },
  }), {
    ...env,
    VOICEVOX_CLOUD_RUN_URL: "https://voicevox.example.run.app",
    VOICEVOX_GCP_SERVICE_ACCOUNT_JSON: "configured-but-never-read-by-status",
  });
  assert.deepEqual(await cloudStatus.json(), {
    available: true,
    backend: "cloud-run",
    version: null,
    latencyMs: null,
    liveCheck: false,
  });
  assert.deepEqual(vpcRequests, [
    "http://localhost:50021/sing_frame_audio_query?speaker=6000",
    "http://localhost:50021/frame_synthesis?speaker=3003",
    "http://localhost:50021/version",
  ]);
});

test.after(async () => {
  await vite.close();
});
