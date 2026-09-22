import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true }, appType: "custom" });
const { default: worker } = await vite.ssrLoadModule("/src/worker.ts");
const evaluation = await vite.ssrLoadModule("/services/evaluationSubmissionService.ts");
const tickets = await vite.ssrLoadModule("/src/creationArchiveTicket.ts");
const drafts = await vite.ssrLoadModule("/services/evaluationDraftDb.ts");
const client = await vite.ssrLoadModule("/services/geminiService.ts");
test.after(() => vite.close());

const secret = "test-only-public-generation-secret-0000";
const lyrics = (line = "ねこ") => ({ title: "ねこのうた", identifiedObject: "ねこ", lines: Array(4).fill("ねこ"), singingKanaLines: Array(4).fill(line), lineStrokeMappings: Array.from({ length: 4 }, (_, lineIndex) => ({ lineIndex, strokeGroupIds: [] })) });
const longLine = "あーーーーいーーーーうーーーーえーーーーお";
const drawingData = { imageUri: "data:image/jpeg;base64,/9j/2Q==", strokes: [] };
const phrase = { moras: [{ text: "ネ", pitch: 5 }, { text: "コ", pitch: 6 }], accent: 2, pause_mora: null };
const analysis = { schemaVersion: 1, objectCandidates: [{ label: "ねこ", confidence: "high" }], parts: [{ id: "body", shape: "丸", position: "中央", strokeGroupIds: [] }], drawingOrder: ["body"] };

function setup(t, { replies = [lyrics()], mode = "legacy", accentFailure = false, denied = false } = {}) {
  const prompts = [], writes = [], models = [], accentCalls = [];
  let lyricCalls = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (url.includes("siteverify")) return Response.json({ success: !denied, hostname: "app.test", action: "generate-ekaki-uta" });
    assert.ok(url.includes(":generateContent"), url);
    const model = decodeURIComponent(url.split("/models/")[1].split(":")[0]);
    models.push(model);
    const prompt = JSON.parse(init.body).contents[0].parts[0].text;
    let result;
    if (model === "vision-model") result = analysis;
    else {
      prompts.push(prompt);
      result = replies[Math.min(lyricCalls++, replies.length - 1)];
      if (mode === "phase1") result = { candidates: [{ ...result, candidateId: "candidate-a" }] };
    }
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] });
  });
  const env = {
    GEMINI_API_KEY: "test", GEMINI_MODEL_CANDIDATES: "gemini-3.8-flash,gemini-3.5-flash", GEMINI_VISION_MODEL: "vision-model", LYRICS_BASE_MODEL: "lyrics-model", LYRICS_CANDIDATE_COUNT: "1",
    LYRICS_PIPELINE_MODE: mode, SINGING_BPM: "120", TURNSTILE_SECRET: "test", TURNSTILE_EXPECTED_HOSTNAME: "app.test",
    EVALUATION_CENTRAL_STORAGE_ENABLED: "true", EVALUATION_RECEIPT_SECRET: secret,
    VOICEVOX_ACCENT_ENABLED: "true", VOICEVOX_JOBS_ENABLED: "true", VOICEVOX_JOBS: {}, TEMPORARY_AUDIO: {}, CREATION_ARCHIVES_ENABLED: "true", CREATION_ARCHIVES: {},
    EVALUATIONS_DB: { prepare: sql => ({ bind: (...values) => ({ run: async () => { writes.push({ sql, values }); return { meta: { changes: 1 } }; } }) }) },
    VOICEVOX: { fetch: async input => { accentCalls.push(String(input)); return accentFailure ? new Response("unavailable", { status: 503 }) : Response.json([phrase]); } },
  };
  const generationId = randomUUID();
  const request = () => worker.fetch(new Request("https://app.test/api/gemini/generate-ekaki-uta", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.test" }, body: JSON.stringify({ drawingData, generationId, turnstileToken: "test" }) }), env);
  return { env, generationId, prompts, writes, models, accentCalls, request };
}

test("public single-stage creates one candidate, aligned phrases and final bound tickets", async t => {
  const run = setup(t);
  const response = await run.request(), result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.deepEqual(run.models, ["gemini-3.8-flash"]);
  assert.equal(result.pipelineMode, "single");
  assert.equal(result.drawingAnalysis, null);
  assert.equal(result.modelInfo.drawingAnalysis, "not-run");
  assert.equal(result.candidates.length, 1);
  assert.equal(run.writes.length, 1);
  assert.equal(run.writes[0].values[2], "candidate-a");
  assert.ok(result.voiceGrants["candidate-a"]);
  assert.ok(result.voiceJobCapability);
  assert.deepEqual(result.accentHints["candidate-a"][0].phraseEnds, [2]);
  assert.equal(run.accentCalls.length, 1, "repeated lines are analyzed once");
  assert.equal(await evaluation.verifyEvaluationReceipt(result.evaluationReceipt, run.generationId, result, secret), true);
  const ticket = await tickets.verifyArchiveGenerationTicket(result.archiveGenerationTicket, secret);
  assert.equal(ticket.imageSha256, createHash("sha256").update(Buffer.from("/9j/2Q==", "base64")).digest("hex"));
  const draft = drafts.createEvaluationDraft({ ...result, generationId: run.generationId, createdAt: new Date().toISOString(), displayOrder: ["candidate-a"], activeCandidateId: "candidate-a" });
  draft.centralConsent = "accepted";
  const submission = evaluation.buildEvaluationSubmission(draft, result.evaluationReceipt, "test", new Date().toISOString(), null);
  assert.equal(submission.firstImpressionSelection, null);
  assert.equal(submission.alternativePreviewed, false);
  assert.equal(await evaluation.verifyEvaluationReceipt(result.evaluationReceipt, run.generationId, submission, secret), true);
  assert.throws(() => evaluation.validateEvaluationSubmission({ ...submission, firstImpressionSelection: "candidate-a" }));
  assert.throws(() => evaluation.validateEvaluationSubmission({ ...submission, alternativePreviewed: true }));
  t.mock.method(globalThis, "fetch", async () => Response.json(result));
  const parsed = await client.generateEkakiUta(drawingData, "test", run.generationId);
  assert.equal(parsed.generationImageUri, drawingData.imageUri);
  assert.deepEqual(parsed.accentHints, result.accentHints);
  assert.equal(parsed.lyrics.candidateId, "candidate-a");
});

for (const mode of ["legacy", "phase1"]) test(`public ${mode} retries only the lyrics, then signs the final shortened output`, async t => {
  const run = setup(t, { mode, replies: [lyrics(longLine), lyrics(longLine), lyrics()] });
  const response = await run.request(), result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(run.prompts.length, 3);
  assert.match(run.prompts[1], /12モーラ/);
  assert.match(run.prompts[2], /8モーラ/);
  assert.match(run.prompts[1], /120 BPM/);
  assert.equal(run.models.filter(model => model === "vision-model").length, mode === "phase1" ? 1 : 0);
  assert.equal(run.writes.length, 1, "no grants issued for rejected lyrics");
  assert.deepEqual(result.candidates[0].singingKanaLines, lyrics().singingKanaLines);
  assert.equal(await evaluation.verifyEvaluationReceipt(result.evaluationReceipt, run.generationId, result, secret), true);
  const changed = { ...result, candidates: [{ ...result.candidates[0], singingKanaLines: lyrics(longLine).singingKanaLines }] };
  assert.equal(await evaluation.verifyEvaluationReceipt(result.evaluationReceipt, run.generationId, changed, secret), false);
});

for (const mode of ["legacy", "phase1"]) test(`public ${mode} stops at two retries without issuing tickets`, async t => {
  const run = setup(t, { mode, replies: [lyrics(longLine)] });
  const response = await run.request(), result = await response.json();
  assert.equal(response.status, 422);
  assert.equal(result.code, "lyrics-too-long");
  assert.equal(run.prompts.length, 3);
  assert.equal(run.writes.length, 0);
  assert.equal(run.accentCalls.length, 0);
});

test("failed accent analysis leaves a usable generated song and voice grant", async t => {
  const run = setup(t, { accentFailure: true });
  const response = await run.request(), result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(result.accentHints["candidate-a"], Array(4).fill({ levels: [] }));
  assert.ok(result.voiceGrants["candidate-a"]);
});

test("Turnstile rejection never reaches Gemini, accent analysis or grant issuance", async t => {
  const run = setup(t, { denied: true });
  assert.equal((await run.request()).status, 403);
  assert.equal(run.models.length + run.accentCalls.length + run.writes.length, 0);
});
