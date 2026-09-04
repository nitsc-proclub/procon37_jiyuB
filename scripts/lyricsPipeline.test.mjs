import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  appType: "custom",
});
const pipeline = await vite.ssrLoadModule("/services/lyricsPipeline.ts");
const evaluationDraftDb = await vite.ssrLoadModule("/services/evaluationDraftDb.ts");
const evaluationSubmission = await vite.ssrLoadModule("/services/evaluationSubmissionService.ts");
const geminiService = await vite.ssrLoadModule("/services/geminiService.ts");

const strokeGroups = [
  {
    id: "g1",
    rawStrokeIndexes: [0],
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    startTime: 0,
    endTime: 10,
    length: 10,
  },
  {
    id: "g2",
    rawStrokeIndexes: [1],
    bounds: { minX: 10, minY: 10, maxX: 20, maxY: 20 },
    startTime: 11,
    endTime: 20,
    length: 10,
  },
];

const validLyrics = (candidateId, groupId) => ({
  candidateId,
  title: "まるのうた",
  // This helper represents a candidate after the Worker has injected its shared subject.
  identifiedObject: "りんご",
  lines: ["まるをかこう", "うえにせん", "よこにせん", "できあがり"],
  singingKanaLines: ["まるおかこお", "うえにせん", "よこにせん", "できあがり"],
  lineStrokeMappings: [
    { lineIndex: 0, strokeGroupIds: [groupId, "unknown"] },
    { lineIndex: 1, strokeGroupIds: [] },
    { lineIndex: 2, strokeGroupIds: [] },
    { lineIndex: 3, strokeGroupIds: [] },
  ],
});

const drawingAnalysis = {
  schemaVersion: 1,
  objectCandidates: [{ label: "りんご", confidence: "high" }],
  parts: [{ id: "body", shape: "丸", position: "中央", strokeGroupIds: ["g1"] }],
  drawingOrder: ["body"],
};

test("drawing analysis removes unknown group IDs and completes drawing order", () => {
  const analysis = pipeline.normalizeDrawingAnalysis(
    {
      schemaVersion: 1,
      objectCandidates: [{ label: "りんご", confidence: "high" }],
      parts: [
        { id: "body", shape: "丸", position: "中央", strokeGroupIds: ["g1", "unknown"] },
        { id: "stem", shape: "線", position: "上", strokeGroupIds: ["g2"] },
      ],
      drawingOrder: ["stem"],
    },
    strokeGroups,
  );
  assert.deepEqual(analysis.parts[0].strokeGroupIds, ["g1"]);
  assert.deepEqual(analysis.drawingOrder, ["stem", "body"]);
});

test("one valid candidate remains usable when its pair is malformed", () => {
  const candidates = pipeline.normalizeLyricsCandidates(
    { candidates: [validLyrics("candidate-a", "g1"), { candidateId: "candidate-b", lines: [] }] },
    strokeGroups,
    drawingAnalysis,
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateId, "candidate-a");
  assert.equal(candidates[0].identifiedObject, "りんご");
  assert.deepEqual(candidates[0].lineStrokeMappings[0].strokeGroupIds, ["g1"]);
});

test("candidate validation rejects non-string lyric fields and malformed mappings", () => {
  assert.throws(
    () =>
      pipeline.normalizeLyricsCandidates(
        {
          candidates: [
            {
              ...validLyrics("candidate-a", "g1"),
              title: "   ",
              lines: ["ok", 12],
              lineStrokeMappings: [{ lineIndex: 0, strokeGroupIds: ["g1"] }],
            },
          ],
        },
        strokeGroups,
        drawingAnalysis,
      ),
    /有効な歌詞候補/,
  );
  assert.throws(
    () => pipeline.normalizeLyricsCandidates({ candidates: [{ ...validLyrics("candidate-a", "g1"), lineStrokeMappings: [{ lineIndex: 0, strokeGroupIds: [12] }] }] }, strokeGroups, drawingAnalysis),
    /有効な歌詞候補/,
  );
});

test("candidate lyrics keep the shared subject and require exactly four short lines", () => {
  const withConflictingSubject = { ...validLyrics("candidate-a", "g1"), identifiedObject: "モンスター" };
  const candidates = pipeline.normalizeLyricsCandidates({ candidates: [withConflictingSubject] }, strokeGroups, drawingAnalysis);
  assert.equal(candidates[0].identifiedObject, "りんご");
  assert.throws(
    () => pipeline.normalizeLyricsCandidates({ candidates: [{ ...validLyrics("candidate-a", "g1"), lines: ["これでは歌詞の一行が必要以上に長くなりすぎます", "うえにせん", "よこにせん", "できあがり"] }] }, strokeGroups, drawingAnalysis),
    /有効な歌詞候補/,
  );
  assert.throws(
    () => pipeline.normalizeLyricsCandidates({ candidates: [{ ...validLyrics("candidate-a", "g1"), lines: ["まるをかこう", "うえにせん", "できあがり"], singingKanaLines: ["まるおかこお", "うえにせん", "できあがり"], lineStrokeMappings: [{ lineIndex: 0, strokeGroupIds: ["g1"] }, { lineIndex: 1, strokeGroupIds: [] }, { lineIndex: 2, strokeGroupIds: [] }] }] }, strokeGroups, drawingAnalysis),
    /有効な歌詞候補/,
  );
  assert.throws(
    () => pipeline.normalizeLyricsCandidates({ candidates: [{ ...validLyrics("candidate-a", "g1"), lines: ["まるをかこう", "うえにせん", "よこにせん", "したにもせん", "できあがり"], singingKanaLines: ["まるおかこお", "うえにせん", "よこにせん", "したにもせん", "できあがり"], lineStrokeMappings: [{ lineIndex: 0, strokeGroupIds: ["g1"] }, { lineIndex: 1, strokeGroupIds: [] }, { lineIndex: 2, strokeGroupIds: [] }, { lineIndex: 3, strokeGroupIds: [] }, { lineIndex: 4, strokeGroupIds: [] }] }] }, strokeGroups, drawingAnalysis),
    /有効な歌詞候補/,
  );
});

test("inline image parser preserves the data URI MIME type", () => {
  assert.deepEqual(pipeline.parseInlineImage("data:image/jpeg;base64,ZmFrZQ=="), { mimeType: "image/jpeg", data: "ZmFrZQ==" });
  assert.equal(pipeline.parseInlineImage("data:text/plain;base64,ZmFrZQ=="), null);
});

test("only DrawingAnalysis schema version 1 is supported", () => {
  assert.equal(pipeline.resolveDrawingAnalysisSchemaVersion(), 1);
  assert.equal(pipeline.resolveDrawingAnalysisSchemaVersion(" 1 "), 1);
  assert.equal(pipeline.resolveDrawingAnalysisSchemaVersion("2"), null);
});

test("lyrics-stage prompt contains only DrawingAnalysis and no image payload", () => {
  const prompt = pipeline.buildLyricsCandidatesPrompt(
    drawingAnalysis,
    "1",
  );
  assert.match(prompt, /DrawingAnalysis JSON/);
  assert.doesNotMatch(prompt, /data:image|raw strokes/i);
  assert.match(prompt, /題材を変えたり/);
  assert.match(prompt, /18文字以内/);
  assert.match(prompt, /identifiedObject は返さない/);
});

test("single-candidate mode constrains the prompt, schema, and normalized response", () => {
  const prompt = pipeline.buildLyricsCandidatesPrompt(drawingAnalysis, "3", 1);
  assert.match(prompt, /候補数は 1 本/);
  assert.match(prompt, /candidate-a を1件だけ/);
  const schema = pipeline.createLyricsCandidatesResponseSchema({ OBJECT: "OBJECT", ARRAY: "ARRAY", STRING: "STRING", INTEGER: "INTEGER" }, 1);
  assert.equal(schema.properties.candidates.minItems, 1);
  assert.equal(schema.properties.candidates.maxItems, 1);
  const candidates = pipeline.normalizeLyricsCandidates({ candidates: [validLyrics("candidate-a", "g1")] }, strokeGroups, drawingAnalysis, 1);
  assert.equal(candidates.length, 1);
  assert.throws(() => pipeline.normalizeLyricsCandidates({ candidates: [validLyrics("candidate-a", "g1"), validLyrics("candidate-b", "g2")] }, strokeGroups, drawingAnalysis, 1), /有効な歌詞候補数/);
});

test("drawing analysis prompt makes the first, confidence-ordered candidate the shared subject", () => {
  const prompt = pipeline.buildDrawingAnalysisPrompt(strokeGroups, "1");
  assert.match(prompt, /最も確からしい題材を先頭/);
  assert.match(prompt, /確からしい順/);
  assert.match(prompt, /候補A\/Bが共有する題材/);
});

test("candidate response schema makes the subject server-owned and bounds line counts", () => {
  const schema = pipeline.createLyricsCandidatesResponseSchema({ OBJECT: "OBJECT", ARRAY: "ARRAY", STRING: "STRING", INTEGER: "INTEGER" });
  const candidate = schema.properties.candidates.items;
  assert.equal("identifiedObject" in candidate.properties, false);
  assert.equal(candidate.properties.lines.minItems, 4);
  assert.equal(candidate.properties.lines.maxItems, 4);
});

test("candidate display length ignores whitespace but still limits visible characters", () => {
  const padded = { ...validLyrics("candidate-a", "g1"), lines: [`${"あ".repeat(18)}  `, "うえにせん", "よこにせん", "できあがり"] };
  assert.equal(pipeline.normalizeLyricsCandidates({ candidates: [padded] }, strokeGroups, drawingAnalysis).length, 1);
  const tooLong = { ...padded, lines: ["あ".repeat(19), "うえにせん", "よこにせん", "できあがり"] };
  assert.throws(() => pipeline.normalizeLyricsCandidates({ candidates: [tooLong] }, strokeGroups, drawingAnalysis), /有効な歌詞候補/);
});

test("phase1 responses retain their exact prompt version for evaluation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    pipelineMode: "phase1",
    drawingAnalysis,
    candidates: [validLyrics("candidate-a", "g1")],
    selectedCandidateId: "candidate-a",
    modelInfo: { drawingAnalysis: "gemini-3.7-flash", lyricsGeneration: "gemini-3.5-flash" },
    lyricsPromptVersion: "2",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const result = await geminiService.generateEkakiUta({ imageUri: "data:image/png;base64,ZmFrZQ==", strokes: [] });
    assert.equal(result.lyricsPromptVersion, "2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("candidate display shuffle preserves immutable candidate IDs", () => {
  const shuffled = evaluationDraftDb.shuffleCandidateIds(["candidate-a", "candidate-b"], () => 0);
  assert.deepEqual(shuffled, ["candidate-b", "candidate-a"]);
  assert.deepEqual([...shuffled].sort(), ["candidate-a", "candidate-b"]);
});

test("the shuffled first candidate is the initial preview candidate", () => {
  const first = { ...validLyrics("candidate-a", "g1"), modelName: "gemini-3.5-flash" };
  const second = { ...validLyrics("candidate-b", "g2"), modelName: "gemini-3.5-flash" };
  const displayOrder = evaluationDraftDb.shuffleCandidateIds([first.candidateId, second.candidateId], () => 0);
  assert.equal(displayOrder[0], "candidate-b");
  assert.equal(evaluationDraftDb.getInitialPreviewCandidate([first, second], displayOrder)?.candidateId, "candidate-b");
});

test("only exactly two distinct candidates enable comparison", () => {
  const first = { ...validLyrics("candidate-a", "g1"), modelName: "gemini-3.5-flash" };
  const second = { ...validLyrics("candidate-b", "g2"), modelName: "gemini-3.5-flash" };
  assert.equal(evaluationDraftDb.isComparableCandidateSet([first, second]), true);
  assert.equal(evaluationDraftDb.isComparableCandidateSet([first]), false);
  assert.equal(evaluationDraftDb.isComparableCandidateSet([first, { ...second, candidateId: "candidate-a" }]), false);
});

test("evaluation generation IDs are UUID-shaped without Math.random fallback", () => {
  const generationId = evaluationDraftDb.createGenerationId();
  assert.match(generationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("evaluation draft builder whitelists fields and selection keeps its generation ID", () => {
  const first = {
    ...validLyrics("candidate-a", "g1"),
    imageUri: "data:image/png;base64,should-not-survive",
    audioBlob: { secret: "should-not-survive" },
    rawStrokes: [{ x: 1 }],
    participantAge: 9,
  };
  const second = { ...validLyrics("candidate-b", "g2") };
  const drawingAnalysis = {
    schemaVersion: 1,
    objectCandidates: [{ label: "りんご", confidence: "high", participantName: "should-not-survive" }],
    parts: [{ id: "body", shape: "丸", position: "中央", strokeGroupIds: ["g1"], imageUri: "should-not-survive" }],
    drawingOrder: ["body"],
    rawStrokes: [{ x: 1 }],
  };
  const draft = evaluationDraftDb.createEvaluationDraft({
    generationId: "generation-1",
    createdAt: "2026-08-22T00:00:00.000Z",
    candidates: [first, second],
    displayOrder: ["candidate-b", "candidate-a"],
    drawingAnalysis,
    modelInfo: { drawingAnalysis: "gemini-3.7-flash", lyricsGeneration: "gemini-3.5-flash", extra: "should-not-survive" },
    lyricsPromptVersion: "2",
    participantAge: 9,
  });
  assert.equal("imageUri" in draft.candidates[0], false);
  assert.equal("audioBlob" in draft.candidates[0], false);
  assert.equal("rawStrokes" in draft.candidates[0], false);
  assert.equal("participantAge" in draft.candidates[0], false);
  assert.equal("rawStrokes" in draft.drawingAnalysis, false);
  assert.equal("participantName" in draft.drawingAnalysis.objectCandidates[0], false);
  assert.deepEqual(draft.modelInfo, { drawingAnalysis: "gemini-3.7-flash", lyricsGeneration: "gemini-3.5-flash" });
  assert.equal(draft.lyricsPromptVersion, "2");

  const selected = evaluationDraftDb.withEvaluationDraftSelection(draft, "neither", "2026-08-22T00:01:00.000Z");
  assert.equal(selected.generationId, "generation-1");
  assert.equal(selected.selection, "neither");
  const attemptedLaterSelection = evaluationDraftDb.withEvaluationDraftSelection(selected, "candidate-a", "2026-08-22T00:02:00.000Z");
  assert.equal(attemptedLaterSelection.selection, "neither");
  assert.equal(attemptedLaterSelection.firstImpressionSelection, "neither");
  const consented = evaluationDraftDb.withEvaluationDraftState(attemptedLaterSelection, {
    centralConsent: "accepted",
    activeCandidateId: "candidate-a",
    alternativePreviewed: true,
  }, "2026-08-22T00:03:00.000Z");
  assert.equal(consented.centralConsent, "accepted");
  assert.equal(consented.activeCandidateId, "candidate-a");
  assert.equal(consented.alternativePreviewed, true);
  assert.equal(consented.firstImpressionSelection, "neither");
  assert.equal(attemptedLaterSelection.centralConsent, "not-asked");
  assert.equal(selected.updatedAt, "2026-08-22T00:01:00.000Z");
  assert.equal(draft.selection, null);
});

const buildSubmissionFixture = () => ({
  schemaVersion: 1,
  generationId: "123e4567-e89b-42d3-a456-426614174000",
  evaluationReceipt: "v1.9999999999999.fingerprint.signature",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:01:00.000Z",
  consentedAt: "2026-08-23T00:01:00.000Z",
  buildId: "test-build",
  experimentRoundId: "phase1-test",
  drawingAnalysisSchemaVersion: 1,
  lyricsPromptVersion: "2",
  firstImpressionSelection: "candidate-a",
  displayOrder: ["candidate-b", "candidate-a"],
  candidates: [
    { ...validLyrics("candidate-a", "g1"), lineStrokeMappings: [{ lineIndex: 0, strokeGroupIds: ["g1"] }, { lineIndex: 1, strokeGroupIds: [] }, { lineIndex: 2, strokeGroupIds: [] }, { lineIndex: 3, strokeGroupIds: [] }], modelName: "gemini-3.5-flash" },
    { ...validLyrics("candidate-b", "g2"), lineStrokeMappings: [{ lineIndex: 0, strokeGroupIds: ["g2"] }, { lineIndex: 1, strokeGroupIds: [] }, { lineIndex: 2, strokeGroupIds: [] }, { lineIndex: 3, strokeGroupIds: [] }], modelName: "gemini-3.5-flash" },
  ],
  strokeGroupIds: ["g1", "g2"],
  drawingAnalysis: {
    schemaVersion: 1,
    objectCandidates: [{ label: "りんご", confidence: "high" }],
    parts: [
      { id: "body", shape: "丸", position: "中央", strokeGroupIds: ["g1"] },
      { id: "stem", shape: "線", position: "上", strokeGroupIds: ["g2"] },
    ],
    drawingOrder: ["body", "stem"],
  },
  modelInfo: { drawingAnalysis: "gemini-3.7-flash", lyricsGeneration: "gemini-3.5-flash" },
  activeCandidateId: "candidate-a",
  alternativePreviewed: false,
  centralConsent: "accepted",
});

test("evaluation receipts bind generation, generated content, and generation contract", async () => {
  const payload = buildSubmissionFixture();
  const secret = "0123456789abcdef0123456789abcdef";
  const receipt = await evaluationSubmission.createEvaluationReceipt(payload.generationId, payload, secret, 1_000, 60);
  payload.evaluationReceipt = receipt.value;
  assert.equal(await evaluationSubmission.verifyEvaluationReceipt(receipt.value, payload.generationId, payload, secret, 2_000), true);
  assert.equal(await evaluationSubmission.verifyEvaluationReceipt(receipt.value, payload.generationId, { ...payload, candidates: [{ ...payload.candidates[0], title: "改ざん" }, payload.candidates[1]] }, secret, 2_000), false);
  assert.equal(await evaluationSubmission.verifyEvaluationReceipt(receipt.value, payload.generationId, { ...payload, lyricsPromptVersion: "forged-version" }, secret, 2_000), false);
  assert.equal(await evaluationSubmission.verifyEvaluationReceipt(receipt.value, payload.generationId, { ...payload, modelInfo: { ...payload.modelInfo, lyricsGeneration: "forged-model" } }, secret, 2_000), false);
  assert.equal(await evaluationSubmission.verifyEvaluationReceipt(receipt.value, "123e4567-e89b-42d3-a456-426614174001", payload, secret, 2_000), false);
  assert.equal(await evaluationSubmission.verifyEvaluationReceipt(receipt.value, payload.generationId, payload, secret, 62_000), false);
});

test("central submission rejects non-whitelisted personal or media fields", () => {
  const payload = buildSubmissionFixture();
  assert.equal(evaluationSubmission.validateEvaluationSubmission(payload).generationId, payload.generationId);
  for (const forbidden of ["imageUri", "audio", "rawStrokes", "participantName", "participantAge", "freeText"]) {
    assert.throws(() => evaluationSubmission.validateEvaluationSubmission({ ...payload, [forbidden]: "must-not-pass" }), /形式が正しく/);
  }
});

test("D1 save is idempotent and never overwrites an approved generation", async () => {
  let row = null;
  const database = {
    prepare(sql) {
      let values = [];
      return {
        bind(...nextValues) { values = nextValues; return this; },
        async run() {
          if (row) return { meta: { changes: 0 } };
          row = { generation_id: values[0], payload_hash: values[1], status: "pending", evaluation_json: values[4] };
          return { meta: { changes: 1 } };
        },
        async first() { return sql.startsWith("SELECT") ? row : null; },
      };
    },
  };
  const payload = buildSubmissionFixture();
  const first = await evaluationSubmission.saveEvaluationIdempotently(database, payload);
  assert.equal(first.duplicate, false);
  row.status = "approved";
  const duplicate = await evaluationSubmission.saveEvaluationIdempotently(database, payload);
  assert.equal(duplicate.duplicate, true);
  assert.equal(row.status, "approved");
  await assert.rejects(
    evaluationSubmission.saveEvaluationIdempotently(database, { ...payload, firstImpressionSelection: "candidate-b" }),
    (error) => error.status === 409 && error.code === "evaluation-conflict",
  );
  assert.equal(row.status, "approved");
});

test.after(async () => {
  await vite.close();
});
