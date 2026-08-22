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
  lines: ["まるをかこう"],
  singingKanaLines: ["まるおかこお"],
  identifiedObject: "りんご",
  lineStrokeMappings: [{ lineIndex: 0, strokeGroupIds: [groupId, "unknown"] }],
});

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
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateId, "candidate-a");
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
      ),
    /有効な歌詞候補/,
  );
  assert.throws(
    () => pipeline.normalizeLyricsCandidates({ candidates: [{ ...validLyrics("candidate-a", "g1"), lineStrokeMappings: [{ lineIndex: 0, strokeGroupIds: [12] }] }] }, strokeGroups),
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
    {
      schemaVersion: 1,
      objectCandidates: [{ label: "りんご", confidence: "high" }],
      parts: [{ id: "body", shape: "丸", position: "中央", strokeGroupIds: ["g1"] }],
      drawingOrder: ["body"],
    },
    "1",
  );
  assert.match(prompt, /DrawingAnalysis JSON/);
  assert.doesNotMatch(prompt, /data:image|raw strokes/i);
});

test.after(async () => {
  await vite.close();
});
