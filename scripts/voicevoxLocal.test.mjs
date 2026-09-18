import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import { build } from "esbuild";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true }, appType: "custom" });
const { createVoicevoxMiddleware } = await vite.ssrLoadModule("/server/voicevoxMiddleware.ts");
const worker = (await vite.ssrLoadModule("/src/worker.ts")).default;
const backend = await vite.ssrLoadModule("/src/voicevoxBackend.ts");
const nativeFetch = globalThis.fetch;
const originalWindow = globalThis.window;
globalThis.window = { setTimeout, clearTimeout };
const browserApi = async (dev) => {
  const result = await build({ stdin: { contents: 'export * from "./services/voicevoxHealthService"; export * from "./services/voicevoxService"; export * from "./services/voicevoxAccentService"; export * from "./services/voicevoxHttp";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "node", define: { "import.meta.env.DEV": String(dev) } });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
};
const dev = await browserApi(true);
const prod = await browserApi(false);
const token = "a".repeat(43);
const score = { notes: [{ lyric: "あ", key: 60, frame_length: 120 }] };
const wav = Buffer.from("RIFF0000WAVEtest-audio");
const env = {
  VOICEVOX_LOCAL_ACCESS_TOKEN: token,
  ASSETS: { fetch: async () => new Response("asset") },
  VOICEVOX: { fetch: async (url) => String(url).includes("/version")
    ? Response.json("0.25.1") : String(url).includes("/sing_frame_audio_query")
      ? Response.json({ outputSamplingRate: 24000 }) : new Response(wav) },
};
const origin = "https://maker.example";
const localConfig = { VOICEVOX_REMOTE_API_URL: origin, VOICEVOX_LOCAL_ACCESS_TOKEN: token };
const relayFetch = (url, init) => worker.fetch(new Request(url, init), env);

async function withLocalServer(config, fetcher, run) {
  const middleware = createVoicevoxMiddleware(config, fetcher);
  const server = createHttpServer((req, res) => { void middleware(req, res, () => { res.writeHead(404); res.end(); }); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  try { await run(local); } finally { await new Promise(resolve => server.close(resolve)); }
}

test("health rejects HTML, unavailable, missing version and mismatched backend; distinguishes configuration", async () => {
  for (const body of ["<!DOCTYPE html>", JSON.stringify({ available: false, backend: "vpc" }), JSON.stringify({ available: true, backend: "vpc", version: null }), JSON.stringify({ available: true, backend: "cloud-run", version: "0.25.1" })]) {
    globalThis.fetch = async () => new Response(body);
    await assert.rejects(dev.checkVoicevoxServerVersion("cloudflare-vpc"));
  }
  globalThis.fetch = async () => Response.json({ available: true, backend: "cloud-run", version: null, liveCheck: false });
  assert.deepEqual(await dev.checkVoicevoxServerVersion("google-cloud-run"), { server: "google-cloud-run", version: null, liveCheck: false });
  globalThis.fetch = async () => Response.json("0.25.1");
  assert.deepEqual(await dev.checkVoicevoxServerVersion("local"), { server: "local", version: "0.25.1", liveCheck: true });
});

test("development remote synthesis bypasses loopback; public synthesis still needs a grant", async () => {
  for (const [server, resolved] of [["cloudflare-vpc", "vpc"], ["google-cloud-run", "cloud-run"]]) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push(url);
      assert.equal(JSON.parse(init.body).backend, resolved);
      return new Response(wav, { headers: { "X-Voicevox-Backend": resolved } });
    };
    let actual;
    const blob = await dev.synthesizeSingingVoice(score, undefined, undefined, { server, onServerResolved: value => { actual = value; } });
    assert.equal(blob.size, wav.length);
    assert.equal(actual, server);
    assert.deepEqual(calls, ["/api/voicevox/synthesize"]);
    await assert.rejects(prod.synthesizeSingingVoice(score, undefined, undefined, { server }), /音声チケット/);
    assert.equal(calls.length, 1);
  }
});

test("local synthesis and accent analysis retain the Engine routes", async () => {
  dev.resetVoicevoxConnection();
  const paths = [];
  globalThis.fetch = async url => {
    paths.push(url);
    if (url.includes("/version")) return Response.json("0.25.1");
    if (url.includes("/accent_phrases")) return Response.json([]);
    if (url.includes("/sing_frame_audio_query")) return Response.json({});
    return new Response(wav);
  };
  await dev.analyzeAccentLines(["まる"]);
  await dev.synthesizeSingingVoice(score, undefined, undefined, { server: "local" });
  assert(paths.every(path => path.startsWith("/voicevox/")));
  assert(paths.some(path => path.startsWith("/voicevox/accent_phrases")));
  assert(paths.some(path => path.startsWith("/voicevox/frame_synthesis")));
});

test("local HTTP relay reaches authenticated Worker, preserves WAV and never returns the credential", async () => {
  await withLocalServer(localConfig, relayFetch, async local => {
    const status = await nativeFetch(`${local}/api/voicevox/status?backend=vpc`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).version, "0.25.1");
    const audio = await nativeFetch(`${local}/api/voicevox/synthesize`, { method: "POST", headers: { Origin: local, "Content-Type": "application/json" }, body: JSON.stringify({ score, backend: "vpc" }) });
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("X-Voicevox-Backend"), "vpc");
    assert.equal(audio.headers.get("Authorization"), null);
    assert(!JSON.stringify([...audio.headers]).includes(token));
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wav);
  });
});

test("local relay rejects cross-site requests, absent configuration, unexpected HTML and oversized bodies", async () => {
  let forwarded = 0;
  const fetcher = async () => { forwarded++; return new Response("<html>", { headers: { "Content-Type": "text/html" } }); };
  await withLocalServer(localConfig, fetcher, async local => {
    const path = `${local}/api/voicevox/status?backend=vpc`;
    assert.equal((await nativeFetch(path, { headers: { Origin: "https://other.example" } })).status, 403);
    assert.equal((await nativeFetch(path, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    const synthesis = `${local}/api/voicevox/synthesize`;
    assert.equal((await nativeFetch(synthesis, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await nativeFetch(synthesis, { method: "POST", headers: { Origin: local, "Content-Type": "application/json" }, body: "x".repeat(256 * 1024 + 1) })).status, 413);
    assert.equal(forwarded, 0);
    assert.equal((await nativeFetch(path)).status, 502);
    assert.equal(forwarded, 1);
  });
  await withLocalServer({}, fetcher, async local => {
    assert.equal((await nativeFetch(`${local}/api/voicevox/status?backend=vpc`)).status, 503);
    assert.equal(forwarded, 1);
  });
});

test("Worker relay authentication cannot bypass public grants or payload limits", async () => {
  const request = (path, authorization, body) => new Request(`${origin}${path}`, { method: body ? "POST" : "GET", headers: { Origin: origin, "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) }, ...(body ? { body } : {}) });
  for (const path of ["/api/voicevox/local/status?backend=vpc", "/api/voicevox/local/synthesize"]) {
    for (const auth of [undefined, token, "Bearer wrong", `Bearer ${"b".repeat(43)}`]) {
      assert.equal((await worker.fetch(request(path, auth, path.endsWith("synthesize") ? JSON.stringify({ score }) : undefined), env)).status, 401);
    }
    assert.equal((await worker.fetch(request(path, `Bearer ${token}`), { ...env, VOICEVOX_LOCAL_ACCESS_TOKEN: undefined })).status, 401);
  }
  const db = { prepare: () => { assert.fail("Invalid grants must not reach D1"); } };
  assert.equal((await worker.fetch(request("/api/voicevox/synthesize", `Bearer ${token}`, JSON.stringify({ score, backend: "vpc" })), { ...env, EVALUATIONS_DB: db })).status, 403);
  assert.equal((await worker.fetch(request("/api/voicevox/local/synthesize", `Bearer ${token}`, "x".repeat(256 * 1024 + 1)), env)).status, 413);
  assert.equal((await worker.fetch(request("/api/voicevox/local/synthesize", `Bearer ${token}`, JSON.stringify({ score: { notes: [] } })), env)).status, 400);
  for (const invalid of ["<html>OK</html>", "{}", '""']) assert.equal(backend.parseVoicevoxVersion(invalid), null);
});

test.after(async () => { globalThis.fetch = nativeFetch; globalThis.window = originalWindow; await vite.close(); });
