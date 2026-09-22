import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { indexedDB, IDBFactory, IDBObjectStore } from "fake-indexeddb";
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
const api = await compile('export * from "./services/debugHistoryDb"; export * from "./gallery/recordSource"; export * from "./services/generationTimingEstimate"; export * from "./utils/generationProgress"; export { galleryRecords } from "./gallery/model";');
const ui = await compile('export * as React from "react"; export { createRoot } from "react-dom/client"; export { GenerationProgressBar } from "./components/GenerationJourney"; export { useGenerationCompletion } from "./hooks/useGenerationCompletion"; export { useDemoRecords } from "./hooks/useDemoRecords";');
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
test("completion survives navigation, hidden tabs and unmount; stale callbacks cannot finish a new run", async () => {
  const { React, createRoot, useGenerationCompletion } = ui;
  let completion;
  function Probe({ visible }) { completion = useGenerationCompletion(visible); return null; }
  const root = createRoot(document.getElementById("root"));
  const render = visible => React.act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe, { visible }))));
  const completed = [];
  await render(true);
  const first = completion.wait(1).then(() => completed.push(1));
  await Promise.resolve(); assert.deepEqual(completed, []);
  await render(false); await first;
  await completion.wait(2).then(() => completed.push(2));
  await render(true);
  const third = completion.wait(3).then(() => completed.push(3));
  completion.complete(2); await Promise.resolve(); assert.deepEqual(completed, [1, 2]);
  completion.complete(3); await third;
  const fourth = completion.wait(4).then(() => completed.push(4));
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  document.dispatchEvent(new Event("visibilitychange")); await fourth;
  delete document.hidden;
  const fifth = completion.wait(5).then(() => completed.push(5));
  await React.act(() => root.unmount()); await fifth;
  assert.deepEqual(completed, [1, 2, 3, 4, 5]);
});

test("empty/failed demo lists stop; explicit retry, revisit and new saves refresh", async t => {
  const { React, createRoot, useDemoRecords } = ui;
  const requests = [];
  t.mock.method(globalThis, "fetch", () => new Promise((resolve, reject) => requests.push({ resolve, reject })));
  let state;
  function Probe({ active }) { state = useDemoRecords(active); return null; }
  const root = createRoot(document.getElementById("root"));
  const render = active => React.act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe, { active }))));
  try {
    await render(true); assert.equal(requests.length, 1);
    await React.act(async () => requests[0].resolve(Response.json({ records: [] })));
    await render(true); assert.equal(requests.length, 1); assert.equal(state.loading, false);
    await React.act(() => { void state.reload(); }); assert.equal(requests.length, 2);
    await React.act(async () => requests[1].reject(new Error("offline")));
    assert.equal(state.error, "offline"); assert.equal(state.loading, false);
    await render(true); assert.equal(requests.length, 2);
    await render(false); await render(true); assert.equal(requests.length, 3);
    await React.act(async () => requests[2].resolve(Response.json({ records: [{ recordId: "new" }] })));
    assert.equal(state.records[0].recordId, "new"); assert.equal(state.error, null);
    await React.act(() => state.invalidate()); assert.equal(requests.length, 4);
    await render(false); await render(true); assert.equal(requests.length, 4);
    await React.act(() => state.invalidate()); assert.equal(requests.length, 4);
    await React.act(async () => requests[3].resolve(Response.json({ records: [] })));
    assert.equal(requests.length, 5);
    await React.act(async () => requests[4].resolve(Response.json({ records: [] })));
  } finally { await React.act(() => root.unmount()); }
});

test("gallery skips damaged records and reads audio only when a song is opened", async t => {
  for (const id of ["healthy", "missing-image", "missing-audio", "invalid-metadata"]) await api.saveDebugHistoryRecord(artifacts(id));
  const db = await request(indexedDB.open("cho-ekaki-uta-debug-history", 3));
  const tx = db.transaction(["images", "assets", "records"], "readwrite");
  tx.objectStore("images").delete("missing-image");
  tx.objectStore("assets").delete("missing-audio");
  tx.objectStore("records").put({ recordId: "invalid-metadata", manifest: null });
  await done(tx);
  let audioReads = 0;
  for (const method of ["get", "getAll", "openCursor"]) {
    const original = IDBObjectStore.prototype[method];
    t.mock.method(IDBObjectStore.prototype, method, function (...args) {
      if (this.name === "assets") audioReads++;
      return original.apply(this, args);
    });
  }
  const revoked = [], revoke = URL.revokeObjectURL;
  t.mock.method(URL, "revokeObjectURL", url => { revoked.push(url); revoke(url); });
  for (let refresh = 0; refresh < 3; refresh++) {
    const snapshot = await api.loadGalleryRecords();
    assert.equal(snapshot.skippedCount, 3);
    assert.deepEqual(api.galleryRecords(snapshot.records).map(record => record.recordId), ["healthy"]);
    assert.equal(snapshot.records[0].audioUrl, null); assert.equal(audioReads, 0);
    snapshot.dispose();
  }
  assert.equal(revoked.length, 3);
  const detail = await api.loadGalleryRecord("healthy");
  assert.equal(audioReads, 1); assert.ok(detail.record.audioUrl.startsWith("blob:")); detail.dispose();
  const allInvalid = db.transaction("images", "readwrite"); allInvalid.objectStore("images").delete("healthy"); await done(allInvalid);
  const empty = await api.loadGalleryRecords();
  assert.equal(empty.records.length, 0); assert.equal(empty.skippedCount, 4); empty.dispose();
  await api.clearDebugHistoryRecords();
  const cleanup = db.transaction("images", "readonly");
  assert.equal(await request(cleanup.objectStore("images").count()), 0);
  db.close();
});

test("version 2 migration retains images, audio, favorites and generation counts", async () => {
  const isolated = new IDBFactory();
  globalThis.indexedDB = isolated;
  try {
    const opening = isolated.open("cho-ekaki-uta-debug-history", 2);
    opening.onupgradeneeded = () => { for (const name of ["records", "assets", "generations"]) opening.result.createObjectStore(name, { keyPath: "recordId" }); };
    const old = await request(opening), item = artifacts("version-two");
    const tx = old.transaction(["records", "assets", "generations"], "readwrite");
    tx.objectStore("records").put({ recordId: "version-two", createdAt: item.manifest.createdAt, manifest: item.manifest, byteSize: 100, isFavorite: true });
    tx.objectStore("assets").put({ recordId: "version-two", imageBlob: item.imageBlob, voiceAudioBlob: item.voiceAudioBlob });
    tx.objectStore("generations").put({ recordId: "unsaved", date: "2026-09-21", recorded: false });
    await done(tx); old.close();
    const upgraded = await compile('export * from "./services/debugHistoryDb";');
    const record = await upgraded.getDebugHistoryRecord("version-two");
    assert.equal(record.isFavorite, true);
    assert.equal(await record.artifacts.imageBlob.text(), "image");
    assert.equal(await record.artifacts.voiceAudioBlob.text(), "RIFF0000WAVE");
    assert.equal((await upgraded.getBrowserUsageStats()).unrecordedGenerations, 1);
    const db = await request(isolated.open("cho-ekaki-uta-debug-history", 3));
    const read = db.transaction("assets", "readonly");
    assert.equal("imageBlob" in await request(read.objectStore("assets").get("version-two")), false);
    await upgraded.deleteDebugHistoryRecord("version-two");
    assert.equal(await upgraded.getDebugHistoryImage("version-two"), null);
    db.close();
  } finally { globalThis.indexedDB = indexedDB; }
});

test.after(() => dom.window.close());
