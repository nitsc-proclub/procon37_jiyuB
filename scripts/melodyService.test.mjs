import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true }, appType: "custom" });
after(() => vite.close());
const melody = await vite.ssrLoadModule("/services/melodyService.ts");
const { rhythmNotesToSingingNotes, resolveSingingBpm, SINGING_BPM } = melody;
const buildSingingScore = (lyrics, seed, hints, bpm = 93.75) => melody.buildSingingScore(lyrics, seed, hints, bpm);
const { buildLineTimings, getScoreFrameLength } = await vite.ssrLoadModule("/utils/playbackTiming.ts");
const lyrics = (lines) => ({ title: "test", identifiedObject: "test", lines, singingKanaLines: lines });
const { buildAlignedAccentHint, analyzeAccentLines } = await vite.ssrLoadModule("/services/voicevoxAccentService.ts");
const phrases = (...groups) => groups.map(group => ({
  moras: group.map(text => ({ text, pitch: 5 })), accent: 1, pause_mora: null,
}));

test("talk phrases align normalized kana, small kana and repeated long vowels without moving offsets", () => {
  const hint = buildAlignedAccentHint("ｷｬｰｰ、 ねこ", phrases(["キャ", "ア", "ア"], ["ネ", "コ"]));
  assert.deepEqual(hint.phraseEnds, [3, 5]);
  assert.equal(hint.levels.length, 5);
  assert.deepEqual(buildAlignedAccentHint("きゃーねこ", phrases(["キャ", "ー"], ["ネ", "コ"])).phraseEnds, [2, 4]);
  assert.deepEqual(buildAlignedAccentHint("おさらを かきましょう", phrases(["オ", "サ", "ラ", "オ"], ["カ", "キ", "マ", "ショ", "オ"])).phraseEnds, [4, 9]);
  assert.deepEqual(buildAlignedAccentHint("えい", phrases(["エ", "エ"])).phraseEnds, [2]);
  assert.deepEqual(buildAlignedAccentHint("はな", phrases(["ワ", "ナ"])), { levels: [] });
  for (const reading of [phrases(["ネ", "コ", "オ"]), phrases(["イ", "ヌ"]), phrases(["ネコ"]), []]) {
    assert.deepEqual(buildAlignedAccentHint("ねこ", reading), { levels: [] });
  }
});

test("local accent response carries phrase boundaries to score generation in the same request", async () => {
  const nativeFetch = globalThis.fetch;
  const nativeWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    return String(url).includes("/version") ? Response.json("0.25.1")
      : Response.json(phrases(["ア", "イ", "ウ", "エ", "オ"]));
  };
  try {
    const analysis = await analyzeAccentLines(["あいうえお"]);
    assert.deepEqual(analysis.hints[0].phraseEnds, [5]);
    assert.equal(calls.filter(url => url.includes("/accent_phrases?")).length, 1);
    const score = buildSingingScore(lyrics(["あいうえお"]), "test", analysis.hints);
    assert.deepEqual(score.notes.slice(1, -1).map(n => n.frame_length / 15), [4, 4, 4, 4, 16]);
    assert.equal(score.notes.at(-1).frame_length, 2);
  } finally { globalThis.fetch = nativeFetch; globalThis.window = nativeWindow; }
});

test("post allocation repairs only internal holds and keeps phrase endpoints, pitches and rests", () => {
  const source = lyrics(["あいうえお かきくけこ", "あいうえお"]);
  const baseline = buildSingingScore(source, "test");
  const refined = buildSingingScore(source, "test", [
    { levels: [], phraseEnds: [5, 10] }, { levels: [], phraseEnds: [5] },
  ]);
  assert.deepEqual(refined.notes.map(n => [n.lyric, n.key]), baseline.notes.map(n => [n.lyric, n.key]));
  // The unaffected first line and its explicit/breath rests stay exactly as generated.
  assert.deepEqual(refined.notes.slice(0, -6), baseline.notes.slice(0, -6));
  assert.deepEqual(refined.notes.slice(-6, -1).map(n => n.frame_length / 15), [4, 4, 4, 4, 16]);
  assertBeatAligned(refined);
  assert.equal(getScoreFrameLength(refined), 962);
  const separate = buildSingingScore(lyrics(["あいうえお"]), "test", [{ levels: [], phraseEnds: [2, 5] }]);
  assert.deepEqual(separate, buildSingingScore(lyrics(["あいうえお"]), "test"), "a phrase-final hold is not an internal hold");
});

test("refinement preserves long-vowel minima, handles dense lines and bounds recipient growth", () => {
  for (const line of ["ねこ", "あーいうえ", "きゃーーねこ", "あ".repeat(28), "あー".repeat(11), "あいう えおか"]) {
    const count = melody.getSingingMoras(line).length;
    const source = lyrics([line]);
    const baseline = buildSingingScore(source, "test");
    const refined = buildSingingScore(source, "test", [{ levels: [], phraseEnds: [count] }]);
    assertBeatAligned(refined);
    refined.notes.forEach((note, i) => assert.ok(note.frame_length <= baseline.notes[i].frame_length + 60));
    if (line === "きゃーーねこ") assert.ok(refined.notes[1].frame_length >= 90);
    if (line === "あーいうえ") assert.ok(refined.notes[1].frame_length >= 60);
    for (const phraseEnds of [[count + 1], [0, count], [count, count]]) {
      assert.deepEqual(buildSingingScore(source, "test", [{ levels: [], phraseEnds }]), baseline);
    }
    const at125 = buildSingingScore(source, "test", [{ levels: [], phraseEnds: [count] }], 125);
    assert.equal(getScoreFrameLength(at125), 362);
  }
});

// At 93.75 BPM, 15 frames are exactly one sixteenth. Inspect musical
// positions independently of the allocator and production frame rounding.
const assertBeatAligned = (score) => {
  let position = 0;
  let offBeatNotes = 0;
  for (const note of score.notes.slice(1, -1)) {
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
    for (const note of score.notes.slice(1, -1)) {
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
  for (const note of score.notes.slice(1, -1)) {
    chunk.push(note.frame_length);
    length += note.frame_length;
    if (length === 480) { chunks.push(chunk); chunk = []; length = 0; }
  }
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks[0], chunks[1]);
  assert.deepEqual(chunks[1], chunks[2]);
  assert.equal(chunks[0].at(-1), 60);
  assert.equal(score.notes.at(-2).key, 60);
  assert.equal(score.notes.at(-1).frame_length, 2);
});

test("kana normalization preserves sung moras and long vowels", () => {
  const score = buildSingingScore(lyrics(["キャー ねこ！"]), "kana");
  assert.deepEqual(score.notes.filter(n => n.key !== null).map(n => n.lyric), ["きゃ", "ね", "こ"]);
  assert.equal(getScoreFrameLength(score), 482);
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
  for (const note of score.notes.slice(1, -1)) assert.equal((note.frame_length / 15) % 2, 0);
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
    assert.equal(getScoreFrameLength(score), 2 + lines.length * 480);
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
      assert.equal(getScoreFrameLength(score), 2 + 960);
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
      assert.equal(getScoreFrameLength(changed), 2 + phraseFrames * 4);
      assert.deepEqual(changed.notes.map(n => [n.lyric, n.key]), base.notes.map(n => [n.lyric, n.key]));
      let units = 0;
      let frames = 0;
      const phrases = [];
      let phrase = [];
      for (let i = 1; i < base.notes.length - 1; i += 1) {
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
  assert.equal(getScoreFrameLength(score), 2 + Math.round(45000 / bpm));
});

test("final tonic is at least as long as the preceding pitched note after all refinements", () => {
  for (const line of ["あーーい", "あいうえおーーか", "あいうえおーー か", "あ".repeat(28) + "いーう", "ねこ", "あ", "あ".repeat(32)]) {
    const source = lyrics(["まるお かこお", line]);
    const hints = [{ levels: [], phraseEnds: [6] }, { levels: [], phraseEnds: [melody.getSingingMoras(line).length] }];
    for (const accent of [undefined, hints]) {
      const score = buildSingingScore(source, "cadence", accent);
      assertBeatAligned(score);
      const sung = score.notes.filter(n => n.key !== null);
      assert.equal(sung.at(-1).key, 60);
      assert.ok(sung.at(-1).frame_length >= sung.at(-2).frame_length, line);
      assert.equal(getScoreFrameLength(score), 962);
      assert.deepEqual(score.notes.slice(0, 9).map(n => n.frame_length), [2, 60, 60, 60, 60, 60, 60, 60, 60]);
      for (const bpm of [105, 125, 180]) {
        const changed = buildSingingScore(source, "cadence", accent, bpm);
        assert.equal(getScoreFrameLength(changed), 2 + 2 * Math.round(45000 / bpm));
        const tail = changed.notes.filter(n => n.key !== null).slice(-2);
        assert.ok(tail[1].frame_length >= tail[0].frame_length - 1, "equal musical values may differ by one rounded frame");
      }
    }
  }
  const pair = buildSingingScore(lyrics(["あーーい"]), "cadence");
  assert.deepEqual(pair.notes.slice(1, -1).map(n => n.frame_length / 15), [16, 16]);
  const denseLine = "あ".repeat(29) + "いーう";
  const dense = buildSingingScore(lyrics([denseLine]), "too-dense");
  assertBeatAligned(dense);
  assert.equal(dense.notes.reduce((sum, n) => sum + n.frame_length, 0), 484);
  assert.equal(dense.notes.filter(n => n.key !== null).map(n => n.lyric).join(""), denseLine.replaceAll("ー", ""));
  assert.equal(dense.notes.filter(n => n.key !== null).at(-1).key, 60);
});

test("oversized lyrics retry with a shorter prompt while fitting lyrics and cadence fallback need no retry", async () => {
  const { generateSingableLyrics } = await vite.ssrLoadModule("/services/singableLyricsGeneration.ts");
  const long = lyrics(["あ".repeat(33)]);
  const short = lyrics(["ねこ"]);
  const feedback = [];
  const result = await generateSingableLyrics(async message => {
    feedback.push(message);
    return feedback.length === 1 ? long : short;
  }, value => [value], 120);
  assert.equal(result, short);
  assert.equal(feedback.length, 2);
  assert.match(feedback[1], /12モーラ/);
  assert.match(feedback[1], /120 BPM/);
  assert.match(feedback[1], /4.00秒/);
  for (const candidate of [short, lyrics(["あ".repeat(29) + "いーう"])]) {
    let calls = 0;
    await generateSingableLyrics(async () => { calls++; return candidate; }, value => [value]);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(generateSingableLyrics(async message => {
    calls++;
    if (calls === 3) assert.match(message, /8モーラ/);
    return [short, long];
  }, value => value), /2回作り直し/);
  assert.equal(calls, 3, "all candidates checked; retries are bounded");
  calls = 0;
  await assert.rejects(generateSingableLyrics(async () => { calls++; throw new Error("network"); }, value => [value]), /network/);
  assert.equal(calls, 1);
});

test("local Gemini middleware retries long lyrics in legacy and phase1 without repeating vision", async () => {
  const { Readable } = await import("node:stream");
  const { createGeminiMiddleware } = await vite.ssrLoadModule("/server/geminiMiddleware.ts");
  const nativeFetch = globalThis.fetch;
  const analysis = { schemaVersion: 1, objectCandidates: [{ label: "ねこ", confidence: "high" }],
    parts: [{ id: "body", shape: "丸", position: "中央", strokeGroupIds: [] }], drawingOrder: ["body"] };
  try {
    for (const mode of ["legacy", "phase1"]) {
      let visionCalls = 0;
      const prompts = [];
      globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.includes(":generateContent")) return Response.json({ models: [{ name: "models/test-model", supportedGenerationMethods: ["generateContent"] }] });
        const body = input instanceof Request ? await input.json() : JSON.parse(init.body);
        let value;
        if (url.includes("vision-model")) { visionCalls++; value = analysis; }
        else {
          prompts.push(body.contents[0].parts[0].text);
          const candidate = { ...lyrics(Array(4).fill("ねこ")),
            singingKanaLines: Array(4).fill(prompts.length === 1 ? "あーーーーいーーーーうーーーーえーーーーお" : "ねこ"),
            candidateId: "candidate-a", lineStrokeMappings: Array.from({ length: 4 }, (_, lineIndex) => ({ lineIndex, strokeGroupIds: [] })) };
          value = mode === "phase1" ? { candidates: [candidate] } : candidate;
        }
        return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(value) }] }, finishReason: "STOP" }] });
      };
      const middleware = createGeminiMiddleware({ GEMINI_API_KEY: "test-only", LYRICS_PIPELINE_MODE: mode,
        GEMINI_MODEL: "test-model", GEMINI_VISION_MODEL: "vision-model", LYRICS_BASE_MODEL: "test-model", VITE_SINGING_BPM: "120" });
      const request = Readable.from([Buffer.from(JSON.stringify({ drawingData: { imageUri: "data:image/png;base64,YQ==", strokes: [] } }))]);
      request.url = "/api/gemini/generate-ekaki-uta";
      request.method = "POST";
      let payload;
      const response = { statusCode: 0, setHeader() {}, end(body) { payload = JSON.parse(body); } };
      await middleware(request, response, () => assert.fail("unexpected next"));
      assert.equal(response.statusCode, 200, JSON.stringify(payload));
      assert.equal(prompts.length, 2);
      assert.match(prompts[1], /120 BPM/);
      assert.match(prompts[1], /12モーラ/);
      assert.equal(visionCalls, mode === "phase1" ? 1 : 0);
      const generated = mode === "phase1" ? payload.candidates[0] : payload;
      assert.deepEqual(generated.singingKanaLines, Array(4).fill("ねこ"));
      assert.doesNotThrow(() => buildSingingScore(generated, melody.createSingingSeed(generated)));
    }
  } finally { globalThis.fetch = nativeFetch; }
});
