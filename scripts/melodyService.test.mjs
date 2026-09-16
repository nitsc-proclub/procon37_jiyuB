import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, appType: "custom" });
after(() => vite.close());
const melody = await vite.ssrLoadModule("/services/melodyService.ts");
const { rhythmNotesToSingingNotes, resolveSingingBpm, SINGING_BPM } = melody;
const buildSingingScore = (lyrics, seed, hints, bpm = 93.75) => melody.buildSingingScore(lyrics, seed, hints, bpm);
const { buildLineTimings } = await vite.ssrLoadModule("/utils/playbackTiming.ts");
const lyrics = (lines) => ({ title: "test", identifiedObject: "test", lines, singingKanaLines: lines });

// At 93.75 BPM, 15 frames are exactly one sixteenth. Inspect musical
// positions independently of the allocator and production frame rounding.
const assertBeatAligned = (score) => {
  let position = 0;
  let offBeatNotes = 0;
  for (const note of score.notes.slice(1)) {
    const length = note.frame_length / 15;
    const offset = position % 4;
    assert.ok(Number.isInteger(length) && length > 0);
    if (offset !== 0) {
      assert.ok(length <= 4 - offset, `${note.lyric}: ${position}+${length} crosses the next beat`);
      offBeatNotes += 1;
      assert.ok(offBeatNotes <= 3, "an off-beat run must resolve within three notes");
    } else {
      offBeatNotes = 0;
      if (length > 4) assert.equal(length % 4, 0);
    }
    position += length;
    if (note.key === null) assert.equal(position % 2, 0, "word breaks cannot shift the next word by a sixteenth");
  }
  assert.equal(position % 32, 0);
};

test("note values convert exactly at 93.75 BPM without rounding", () => {
  assert.equal(SINGING_BPM, 125);
  for (const [sixteenths, frames] of [[1, 15], [2, 30], [3, 45], [4, 60], [8, 120], [16, 240]]) {
    assert.equal(rhythmNotesToSingingNotes([{ lyric: "あ", key: 64, sixteenths }], 93.75)[0].frame_length, frames);
  }
  for (const sixteenths of [0, -1, 0.5, NaN, Infinity]) {
    assert.throws(() => rhythmNotesToSingingNotes([{ lyric: "あ", key: 64, sixteenths }]));
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

test("reported lyrics stay on eighths and beats, with full mora lengths for long vowels", () => {
  const lines = [
    "まっすぐよこにせんおひき",
    "したおぐるっとかこみましょー",
    "ちいさなまるおみっつならべて",
    "まっすぐせんおひけばほーちょーだ",
  ];
  const score = buildSingingScore(lyrics(lines), "reported-rhythm");
  assertBeatAligned(score);
  for (const note of score.notes.slice(1)) assert.equal((note.frame_length / 15) % 2, 0);
  const ending = score.notes.filter(n => n.key !== null).slice(-3);
  assert.deepEqual(ending.map(n => n.lyric), ["ほ", "ちょ", "だ"]);
  assert.ok(ending[0].frame_length >= 60);
  assert.ok(ending[1].frame_length >= 60);
  assert.equal(ending.at(-1).key, 60);
});

test("all supported mora counts return to the beat instead of carrying displacement", () => {
  for (let count = 1; count <= 32; count += 1) {
    const line = "あ".repeat(count);
    const lines = count <= 28 ? [line, line] : [line];
    const score = buildSingingScore(lyrics(lines), `density-${count}`);
    assertBeatAligned(score);
    assert.equal(score.notes.filter(n => n.key !== null).length, count * lines.length);
    assert.equal(score.notes.slice(1).reduce((sum, n) => sum + n.frame_length, 0), lines.length * 480);
  }
});

test("word breaks and varied group templates preserve beat alignment and lyric order", () => {
  const lines = [
    "あいうえお かき", "あ いうえおかきくけこさしすせそた",
    "まるお かいて みみ", "ちいさな まるお みっつ かこお",
    "あい うえ おか きく けこ", "あ い う え お か", "あ あ あ あ あ あ あ あ あ あ あ",
    "きゃー ねこ みゃーー", "あいうえおかきくけこさしすせそたちつてとなに",
  ];
  for (const line of lines) {
    for (let seed = 0; seed < 20; seed += 1) {
      const score = buildSingingScore(lyrics([line, line]), String(seed));
      assertBeatAligned(score);
      assert.equal(score.notes.filter(n => n.key !== null).map(n => n.lyric).join(""), line.replace(/[ ー]/g, "").repeat(2));
      assert.equal(score.notes.slice(1).reduce((sum, n) => sum + n.frame_length, 0), 960);
    }
  }
});

test("successive long marks reserve full moras without extra attacks or dropped lyrics", () => {
  for (const [line, minimumHold] of [["あ".repeat(12) + "ねーー", 6], ["あー".repeat(11), 2]]) {
    const score = buildSingingScore(lyrics([line]), "long-vowels");
    assertBeatAligned(score);
    const sung = score.notes.filter(n => n.key !== null);
    assert.equal(sung.map(n => n.lyric).join(""), line.replaceAll("ー", ""));
    assert.ok(sung.at(-1).frame_length >= minimumHold * 15);
    if (line === "あー".repeat(11)) assert.ok(sung.every(n => n.frame_length >= 30));
  }
  assert.throws(() => buildSingingScore(lyrics(["あー".repeat(17)]), "long"), /長すぎ/);
  assert.throws(() => buildSingingScore(lyrics(["あ".repeat(28) + "ー", "あ"]), "long"), /長すぎ/);
});

test("accent hints after long vowels keep their original mora positions", () => {
  const source = lyrics(["あーいーうえおか"]);
  for (let seed = 0; seed < 20; seed += 1) {
    const original = [{ levels: ["mid", "low", "high", "low", "low", "high", "mid", "low"] }];
    const changedHolds = [{ levels: ["mid", "high", "high", "high", "low", "high", "mid", "low"] }];
    assert.deepEqual(buildSingingScore(source, String(seed), original), buildSingingScore(source, String(seed), changedHolds));
  }
});

test("over-capacity lyrics fail instead of shortening notes off the grid", () => {
  assert.throws(() => buildSingingScore(lyrics(["あ".repeat(33)]), "long"), /長すぎ/);
  assert.throws(() => buildSingingScore(lyrics(["あ".repeat(29), "あ"]), "long"), /長すぎ/);
});

test("tempo configuration accepts decimal BPM and rejects invalid values", () => {
  for (const value of [undefined, "", " "]) assert.equal(resolveSingingBpm(value), 125);
  assert.equal(resolveSingingBpm("112.5"), 112.5);
  for (const value of ["abc", "Infinity", 0, 59, 181, NaN]) assert.throws(() => resolveSingingBpm(value), /BPM/);
});

test("arbitrary tempos preserve note values, fixed line lengths and bounded position error", () => {
  const source = lyrics(["まるお かこお", "まるお かこお", "あ".repeat(22), "かめの できあがり"]);
  for (const bpm of [60, 93.75, 105, 112.5, 120, 125, 140.625, 180]) {
    for (let seed = 0; seed < 10; seed += 1) {
      const base = buildSingingScore(source, String(seed));
      const changed = buildSingingScore(source, String(seed), undefined, bpm);
      const phraseFrames = Math.round(45000 / bpm);
      assert.equal(changed.notes.reduce((sum, n) => sum + n.frame_length, 0), 2 + phraseFrames * 4);
      assert.deepEqual(changed.notes.map(n => [n.lyric, n.key]), base.notes.map(n => [n.lyric, n.key]));
      let units = 0;
      let frames = 0;
      const phrases = [];
      let phrase = [];
      for (let i = 1; i < base.notes.length; i += 1) {
        units += base.notes[i].frame_length / 15;
        const length = changed.notes[i].frame_length;
        assert.ok(Number.isInteger(length) && length > 0);
        frames += length;
        phrase.push(length);
        assert.ok(Math.abs(frames - units * phraseFrames / 32) <= 0.5);
        if (units === 32) {
          assert.equal(frames, phraseFrames);
          phrases.push(phrase);
          units = 0;
          frames = 0;
          phrase = [];
        }
      }
      assert.equal(phrases.length, 4);
      assert.deepEqual(phrases[0], phrases[1]);
    }
  }
});

test("default score tempo follows the Vite setting", () => {
  const bpm = resolveSingingBpm(vite.config.env.VITE_SINGING_BPM);
  const score = melody.buildSingingScore(lyrics(["あ"]), "env");
  assert.equal(score.notes.reduce((sum, n) => sum + n.frame_length, 0), 2 + Math.round(45000 / bpm));
});
