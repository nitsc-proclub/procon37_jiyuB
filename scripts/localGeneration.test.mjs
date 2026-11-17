import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Readable } from "node:stream";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, appType: "custom" });
after(() => vite.close());
const { createLocalGenerationMiddleware, getLocalGenerationConfig } = await vite.ssrLoadModule("/server/localGenerationMiddleware.ts");
const { redactDebugBundleText } = await vite.ssrLoadModule("/services/debugBundleService.ts");
const drawing = { imageUri: "data:image/png;base64,YQ==", strokes: [] };
const env = { AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-proj-testsecret1234567890", LYRICS_PIPELINE_MODE: "legacy" };
const lyrics = { title: "まる", identifiedObject: "まる", lines: ["まる", "まる", "まる", "まる"], singingKanaLines: ["まる", "まる", "まる", "まる"], lineStrokeMappings: [] };
const completed = (value = lyrics) => ({ object: "response", id: "resp_test", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
async function invoke(settings = env, options = {}) {
  const req = Readable.from([Buffer.from(options.raw ?? JSON.stringify({ drawingData: drawing }))]);
  req.url = options.url ?? "/api/gemini/generate-ekaki-uta";
  req.method = options.method ?? "POST";
  req.headers = { host: "localhost:3000", ...options.headers };
  let payload;
  const res = { setHeader() {}, end(body) { payload = body && JSON.parse(body); } };
  await createLocalGenerationMiddleware(settings)(req, res, () => { throw new Error("unexpected next"); });
  return { status: res.statusCode, body: payload };
}
async function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try { await run(); } finally { globalThis.fetch = original; }
}

test("default Gemini; config response contains no credentials", async () => {
  assert.equal(getLocalGenerationConfig({}).provider, "gemini");
  const result = await invoke(env, { url: "/api/local/generation-config", method: "GET" });
  assert.deepEqual(result.body, { provider: "openai", model: "gpt-6.1-terra", keyConfigured: true, pipelineMode: "legacy" });
  assert.ok(!JSON.stringify(result).includes(env.OPENAI_API_KEY));
});
test("OpenAI sends image and strict schema; returns existing lyrics contract", async () => {
  let calls = 0;
  await withFetch(async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "gpt-6.1-terra");
    assert.equal(body.store, false);
    assert.equal(body.input[0].content[1].image_url, drawing.imageUri);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.schema.additionalProperties, false);
    assert.equal(body.text.format.schema.properties.lineStrokeMappings.items.additionalProperties, false);
    return Response.json(completed());
  }, async () => {
    const result = await invoke();
    assert.equal(result.status, 200);
    assert.equal(result.body.modelName, "gpt-6.1-terra");
    assert.deepEqual(result.body.lines, lyrics.lines);
  });
  assert.equal(calls, 1);
});
test("missing key, unsupported pipeline/provider, malformed body and cross-site requests make no API calls", async () => {
  await withFetch(() => { throw new Error("must not call API"); }, async () => {
    assert.equal((await invoke({ ...env, OPENAI_API_KEY: "" })).status, 503);
    assert.equal((await invoke({ ...env, LYRICS_PIPELINE_MODE: "phase1" })).status, 400);
    assert.equal((await invoke({ ...env, AI_PROVIDER: "invalid" })).status, 503);
    assert.equal((await invoke(env, { raw: "{" })).status, 400);
    assert.equal((await invoke(env, { headers: { origin: "https://another.test" } })).status, 403);
    assert.equal((await invoke(env, { method: "GET" })).status, 405);
  });
});
test("API errors are sanitized without provider fallback or automatic retries", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await withFetch(async () => { calls++; return Response.json({ error: { message: env.OPENAI_API_KEY, type: "test" } }, { status }); }, async () => {
      const result = await invoke();
      assert.equal(result.status, status === 429 ? 429 : status === 500 ? 502 : 503);
      assert.ok(!JSON.stringify(result).includes(env.OPENAI_API_KEY));
    });
    assert.equal(calls, 1);
  }
});
test("refusal, incomplete output and invalid JSON are reported", async () => {
  for (const [body, status] of [
    [{ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }, 422],
    [{ status: "incomplete", output: [] }, 502],
    [completed({ lines: [] }), 502],
  ]) {
    await withFetch(async () => Response.json(body), async () => assert.equal((await invoke()).status, status));
  }
});
test("capacity retry uses feedback and stops after two regenerations", async () => {
  let calls = 0;
  await withFetch(async (_url, init) => {
    calls++;
    if (calls > 1) assert.match(JSON.parse(init.body).input[0].content[0].text, /前回の歌唱用かな/);
    return Response.json(completed({ ...lyrics, singingKanaLines: Array(4).fill("あ".repeat(100)) }));
  }, async () => assert.equal((await invoke()).status, 422));
  assert.equal(calls, 3);
});
test("Gemini remains available through the dispatcher", async () => {
  const result = await invoke({ AI_PROVIDER: "gemini" });
  assert.match(result.body.error, /GEMINI_API_KEY/);
});
test("debug exports redact OpenAI project keys", () => {
  assert.equal(redactDebugBundleText(env.OPENAI_API_KEY), "[REDACTED_OPENAI_API_KEY]");
});
