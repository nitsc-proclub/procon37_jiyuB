import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, appType: "custom" });
after(() => vite.close());
const { buildSingingScore, rhythmNoteToSingingNote, SINGING_BPM } = await vite.ssrLoadModule("/services/melodyService.ts");
const { buildLineTimings } = await vite.ssrLoadModule("/utils/playbackTiming.ts");
const lyrics = (lines) => ({ title: "test", identifiedObject: "test", lines, singingKanaLines: lines });

test("note values convert exactly at 93.75 BPM without rounding", () => {
  assert.equal(SINGING_BPM, 93.75);
  for (const [sixteenths, frames] of [[1, 15], [2, 30], [3, 45], [4, 60], [8, 120], [16, 240]]) {
    assert.equal(rhythmNoteToSingingNote({ lyric: "あ", key: 64, sixteenths }).frame_length, frames);
  }
  for (const sixteenths of [0, -1, 0.5, NaN, Infinity]) {
    assert.throws(() => rhythmNoteToSingingNote({ lyric: "あ", key: 64, sixteenths }));
  }
});

test("all lines occupy two bars, with every onset and rest on the sixteenth grid", () => {
  const lines = ["まるお かこお", "ちいさな まるお ふたつ", "あ".repeat(22), "かめの できあがり"];
  for (let seed = 0; seed < 100; seed += 1) {
    const score = buildSingingScore(lyrics(lines), String(seed));
    assert.equal(score.notes[0].frame_length, 2);
    let frames = 0;
    const boundaries = new Set([0]);
    for (const note of score.notes.slice(1)) {
      assert.ok(Number.isInteger(note.frame_length) && note.frame_length > 0);
      assert.equal(note.frame_length % 15, 0);
      frames += note.frame_length;
      boundaries.add(frames);
    }
    assert.equal(frames, 1920);
    for (const end of [480, 960, 1440, 1920]) assert.ok(boundaries.has(end));
    assert.deepEqual(buildLineTimings(score, 4).map(({ startFrame, endFrame }) => [startFrame, endFrame]),
      [[2, 482], [482, 962], [962, 1442], [1442, 1922]]);
  }
});

test("identical non-final lines repeat durations and reserve a quarter rest", () => {
  const score = buildSingingScore(lyrics(Array(4).fill("まるお かこお")), "repeat");
  const chunks = [];
  let chunk = [];
  let length = 0;
  for (const note of score.notes.slice(1)) {
    chunk.push(note.frame_length);
    length += note.frame_length;
    if (length === 480) { chunks.push(chunk); chunk = []; length = 0; }
  }
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks[0], chunks[1]);
  assert.deepEqual(chunks[1], chunks[2]);
  assert.equal(chunks[0].at(-1), 60);
  assert.equal(score.notes.at(-1).key, 60);
});

test("kana normalization preserves sung moras and long vowels", () => {
  const score = buildSingingScore(lyrics(["キャー ねこ！"]), "kana");
  assert.deepEqual(score.notes.filter(n => n.key !== null).map(n => n.lyric), ["きゃ", "ね", "こ"]);
  assert.equal(score.notes.slice(1).reduce((sum, n) => sum + n.frame_length, 0), 480);
});

test("over-capacity lyrics fail instead of shortening notes off the grid", () => {
  assert.throws(() => buildSingingScore(lyrics(["あ".repeat(33)]), "long"), /長すぎ/);
  assert.throws(() => buildSingingScore(lyrics(["あ".repeat(29), "あ"]), "long"), /長すぎ/);
});
