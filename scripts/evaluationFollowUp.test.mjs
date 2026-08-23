import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  appType: "custom",
});
const followUpService = await vite.ssrLoadModule("/services/evaluationFollowUpService.ts");

const lyricCandidate = (candidateId, groupId) => ({
  candidateId,
  title: candidateId === "candidate-a" ? "かめのうた" : "ゆっくりかめ",
  identifiedObject: "かめ",
  lines: ["まるをかこう", "あしをつけて", "こうらをかいて", "かめのできあがり"],
  singingKanaLines: ["まるおかこお", "あしおつけて", "こおらおかいて", "かめのできあがり"],
  lineStrokeMappings: [
    { lineIndex: 0, strokeGroupIds: [groupId] },
    { lineIndex: 1, strokeGroupIds: [] },
    { lineIndex: 2, strokeGroupIds: [] },
    { lineIndex: 3, strokeGroupIds: [] },
  ],
  modelName: "gemini-3.5-flash",
});

const baseEvaluation = {
  schemaVersion: 1,
  generationId: "123e4567-e89b-42d3-a456-426614174000",
  evaluationReceipt: "v1.9999999999999.fingerprint.signature",
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:01:00.000Z",
  consentedAt: "2026-08-24T00:01:00.000Z",
  buildId: "test-build",
  experimentRoundId: "phase1-test",
  drawingAnalysisSchemaVersion: 1,
  lyricsPromptVersion: "3",
  firstImpressionSelection: "candidate-a",
  displayOrder: ["candidate-b", "candidate-a"],
  candidates: [lyricCandidate("candidate-a", "g1"), lyricCandidate("candidate-b", "g2")],
  strokeGroupIds: ["g1", "g2"],
  drawingAnalysis: {
    schemaVersion: 1,
    objectCandidates: [
      { label: "かめ", confidence: "high" },
      { label: "モンスター", confidence: "medium" },
      { label: "いし", confidence: "low" },
    ],
    parts: [
      { id: "body", shape: "丸", position: "中央", strokeGroupIds: ["g1"] },
      { id: "leg", shape: "線", position: "下", strokeGroupIds: ["g2"] },
    ],
    drawingOrder: ["body", "leg"],
  },
  modelInfo: { drawingAnalysis: "gemini-3.7-flash", lyricsGeneration: "gemini-3.5-flash" },
  activeCandidateId: "candidate-b",
  alternativePreviewed: true,
  centralConsent: "accepted",
};

const followUp = {
  schemaVersion: 1,
  generationId: baseEvaluation.generationId,
  evaluationReceipt: baseEvaluation.evaluationReceipt,
  updatedAt: "2026-08-24T00:03:00.000Z",
  finalPreferenceSelection: "candidate-b",
  subjectFeedbackChoice: "alternate-1",
  ratings: {
    drawingSongQuality: "good",
    drawingOrderClarity: "okay",
    childFriendliness: "good",
    singability: "needs-work",
  },
};

test("follow-up accepts only fixed choices and never free text", () => {
  assert.equal(followUpService.validateEvaluationFollowUpSubmission(followUp).generationId, baseEvaluation.generationId);
  assert.throws(
    () => followUpService.validateEvaluationFollowUpSubmission({ ...followUp, freeText: "かめです" }),
    /形式が正しく/,
  );
  assert.throws(
    () => followUpService.validateEvaluationFollowUpSubmission({ ...followUp, ratings: { ...followUp.ratings, secretDimension: "good" } }),
    /形式が正しく/,
  );
  assert.throws(
    () => followUpService.validateEvaluationFollowUpSubmission({ ...followUp, finalPreferenceSelection: null, subjectFeedbackChoice: null, ratings: {} }),
    /形式が正しく/,
  );
});

test("malformed follow-up JSON is a bounded client error", () => {
  assert.throws(
    () => followUpService.parseEvaluationFollowUpSubmission("{not-json"),
    (error) => error.status === 400 && error.code === "invalid-evaluation-follow-up",
  );
});

test("follow-up loads only pending base evaluations", async () => {
  const storedJson = JSON.stringify(Object.fromEntries(Object.entries(baseEvaluation).filter(([key]) => key !== "evaluationReceipt")));
  const databaseFor = (status) => ({
    prepare() {
      return {
        bind() { return this; },
        async run() { return { meta: { changes: 0 } }; },
        async first() { return { evaluation_json: storedJson, status }; },
      };
    },
  });
  const loaded = await followUpService.loadStoredEvaluationForFollowUp(databaseFor("pending"), baseEvaluation.generationId, baseEvaluation.evaluationReceipt);
  assert.equal(loaded.firstImpressionSelection, "candidate-a");
  await assert.rejects(
    followUpService.loadStoredEvaluationForFollowUp(databaseFor("approved"), baseEvaluation.generationId, baseEvaluation.evaluationReceipt),
    (error) => error.status === 409 && error.code === "evaluation-already-reviewed",
  );
});

test("D1 follow-up derives the subject label from stored analysis and is idempotent", async () => {
  let row = null;
  let insertValues = null;
  const database = {
    prepare(sql) {
      let values = [];
      return {
        bind(...nextValues) { values = nextValues; return this; },
        async run() {
          insertValues = values;
          row = {
            final_preference_selection: values[4],
            subject_feedback_choice: values[5],
            subject_feedback_label: values[6],
            rating_drawing_song_quality: values[7],
            rating_drawing_order_clarity: values[8],
            rating_child_friendliness: values[9],
            rating_singability: values[10],
          };
          return { meta: { changes: 1 } };
        },
        async first() { return sql.startsWith("SELECT final_preference") ? row : null; },
      };
    },
  };
  const first = await followUpService.saveEvaluationFollowUp(database, baseEvaluation, followUp, "2026-08-24T00:04:00.000Z");
  assert.equal(first.duplicate, false);
  assert.equal(insertValues[3], "2026-08-24T00:04:00.000Z");
  assert.equal(insertValues[6], "モンスター");
  assert.equal(insertValues[7], "good");
  const duplicate = await followUpService.saveEvaluationFollowUp(database, baseEvaluation, followUp, "2026-08-24T00:05:00.000Z");
  assert.equal(duplicate.duplicate, true);
  const cleared = await followUpService.saveEvaluationFollowUp(database, baseEvaluation, { ...followUp, subjectFeedbackChoice: null, ratings: {} }, "2026-08-24T00:06:00.000Z");
  assert.equal(cleared.duplicate, false);
  assert.equal(row.subject_feedback_choice, null);
  assert.equal(row.subject_feedback_label, null);
  assert.equal(row.rating_drawing_song_quality, null);
});

test.after(async () => {
  await vite.close();
});
