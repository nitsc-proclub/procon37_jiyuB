import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { indexedDB } from "fake-indexeddb";
import { createRequire } from "node:module";

const dom = new JSDOM("<div id='root'></div>", { url: "https://app.test", pretendToBeVisual: true });
const document = dom.window.document;
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event,
  localStorage: dom.window.localStorage, indexedDB, IS_REACT_ACT_ENVIRONMENT: true });
const compile = async contents => {
  const result = await build({ stdin: { contents, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false,
    format: "cjs", platform: "node", packages: "external", define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true }), "process.env.NODE_ENV": '"development"' } });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
};
const api = await compile('export * from "./services/debugHistoryDb"; export * from "./gallery/recordSource"; export * from "./services/generationTimingEstimate"; export * from "./utils/generationProgress";');
const ui = await compile('export * as React from "react"; export { createRoot } from "react-dom/client"; export { GenerationProgressBar } from "./components/GenerationJourney";');
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
const artifacts = (recordId, startedAt = "2026-09-21T16:00:00Z") => ({
  manifest: { recordId, createdAt: startedAt, generation: { startedAt }, drawing: { strokes: [], strokeGroups: [] },
    lyrics: { title: recordId, identifiedObject: "ねこ", lines: ["ねこ"], singingKanaLines: ["ねこ"] },
    singingScore: { notes: [{ lyric: "ね", key: 60, frame_length: 40 }] }, audio: { path: "voice.wav" } },
  imageBlob: new Blob(["image"]), voiceAudioBlob: new Blob(["RIFF0000WAVE"]),
});

test("browser records migrate without uploads; favorites survive replacement; counts persist independently of deletion/import", async t => {
  t.mock.method(globalThis, "fetch", () => { assert.fail("Browser saves/gallery must not send network requests"); });
  const opening = indexedDB.open("cho-ekaki-uta-debug-history", 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore("records", { keyPath: "recordId" });
    db.createObjectStore("assets", { keyPath: "recordId" });
  };
  const oldDb = await request(opening);
  const old = artifacts("legacy", "2026-09-20T14:00:00Z");
  const tx = oldDb.transaction(["records", "assets"], "readwrite");
  tx.objectStore("records").put({ recordId: "legacy", createdAt: old.manifest.createdAt, manifest: old.manifest, byteSize: 100 });
  tx.objectStore("assets").put({ recordId: "legacy", ...old });
  await done(tx); oldDb.close();
  assert.equal((await api.getBrowserUsageStats()).recordedGenerations, 1);
  await Promise.all([api.recordBrowserGeneration("new", "2026-09-21T16:00:00Z"), api.recordBrowserGeneration("new", "2026-09-21T16:00:00Z")]);
  await api.recordBrowserGeneration("declined", "2026-09-21T16:00:00Z");
  assert.equal((await api.getBrowserUsageStats()).totalGenerations, 3);
  await api.saveDebugHistoryRecord(artifacts("new"));
  await api.setDebugHistoryFavorite("new", true);
  await api.saveDebugHistoryRecord(artifacts("new"));
  assert.equal((await api.getDebugHistoryRecord("new")).isFavorite, true);
  await api.saveDebugHistoryRecord(artifacts("imported"));
  const snapshot = await api.loadGalleryRecords();
  assert.equal(snapshot.records.length, 3);
  assert.equal(snapshot.records.find(r => r.recordId === "new").isFavorite, true);
  const detail = await api.loadGalleryRecord("new");
  assert.equal(detail.record.lyrics.title, "new");
  assert.ok(detail.record.audioUrl.startsWith("blob:"));
  detail.dispose(); snapshot.dispose();
  const stats = await api.getBrowserUsageStats();
  assert.deepEqual(stats.days[0], { date: "2026-09-22", generationCount: 2, recordedCount: 1, unrecordedCount: 1 });
  assert.equal(stats.recordedGenerations, 2);
  await api.deleteDebugHistoryRecord("new");
  await api.clearDebugHistoryRecords();
  assert.deepEqual(await api.getBrowserUsageStats(), stats);
});

test("four consecutive rendered progress runs reset, freeze their estimates, move smoothly and complete exactly once", async t => {
  let clock = 0, nextId = 0;
  const frames = new Map();
  t.mock.method(performance, "now", () => clock);
  globalThis.requestAnimationFrame = callback => { const id = ++nextId; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const { React, createRoot, GenerationProgressBar } = ui;
  const root = createRoot(document.getElementById("root"));
  const completions = [];
  const value = () => Number(document.querySelector("[role=progressbar] > div > div").style.width.replace("%", ""));
  const frame = () => React.act(() => { clock += 16; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(clock)); });
  try {
    for (let runKey = 1; runKey <= 4; runKey++) {
      const estimate = api.readTimingEstimate("test");
      const render = (progressPhase, isComplete = false, timingEstimate = estimate) => React.act(() => root.render(
        React.createElement(React.StrictMode, null, React.createElement(GenerationProgressBar, { runKey, progressPhase, isComplete, timingEstimate, onCompletionDisplayComplete: key => completions.push(key) })),
      ));
      await render("gemini");
      assert.equal(value(), 0);
      for (let i = 0; i < 100; i++) { const before = value(); await frame(); assert.ok(value() - before <= .353); }
      await render("voicevoxSynthesis", false, { determinate: true, phaseDurationsMs: { gemini: 1 } });
      const before = value(); clock += 30_000; await frame();
      assert.ok(value() - before <= 1.101, "returning from a suspended tab cannot leap");
      await render("finalize", true);
      for (let i = 0; i < 240; i++) await frame();
      assert.equal(value(), 100);
      assert.deepEqual(completions, Array.from({ length: runKey }, (_, i) => i + 1));
      api.rememberTiming("test", { gemini: 100, score: 1, voicevoxSynthesis: 50 });
    }
  } finally { await React.act(() => root.unmount()); }
  assert.equal(frames.size, 0);
});

test("learning has no third-run threshold and handles corrupt browser storage", () => {
  localStorage.clear();
  const estimates = [];
  for (let i = 0; i < 5; i++) { estimates.push(api.readTimingEstimate("profile").phaseDurationsMs.gemini); api.rememberTiming("profile", { gemini: 100 }); }
  for (let i = 1; i < estimates.length; i++) assert.ok(Math.abs(estimates[i] - estimates[i - 1]) < 700);
  localStorage.setItem("ekaki-progress-v2:profile", "broken");
  assert.equal(api.readTimingEstimate("profile").phaseDurationsMs.gemini, 16000);
  for (const phase of ["gemini", "score", "voicevoxSynthesis", "finalize"]) assert.ok(api.getGenerationPhaseProgressTarget(phase, 1e9) < 100);
});
test.after(() => dom.window.close());
