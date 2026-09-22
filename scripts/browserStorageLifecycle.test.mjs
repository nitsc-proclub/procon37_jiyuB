import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";

const bundle = await build({ stdin: { contents: `export * from "./services/debugHistoryDb";
  export * from "./services/evaluationDraftDb"; export * from "./services/debugBundleService";
  export * from "./services/debugBundleImportService";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external" });
const fresh = () => {
  globalThis.indexedDB = new IDBFactory();
  globalThis.window = new EventTarget();
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
};
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
const candidate = (candidateId = "candidate-a") => ({ candidateId, title: `ねこのうた${candidateId}`, identifiedObject: "ねこ",
  lines: ["まるいねこ"], singingKanaLines: ["まるいねこ"], lineStrokeMappings: [], modelName: "test-model" });
const source = (recordId = "record-one", lyrics = candidate()) => ({ recordId,
  drawingData: { imageUri: "data:image/png;base64,iVBORw0KGgo=", strokes: [], strokeGroups: [], canvasSize: { width: 100, height: 100 }, lineWidth: 3 },
  lyrics, singingScore: { notes: [{ lyric: "ま", key: 60, frame_length: 30 }] },
  voiceAudioBlob: null, playbackKind: "animation-only", voicevoxStatus: "not-attempted", voicevoxIssue: null,
  startedAt: "2026-09-22T00:00:00.000Z", completedAt: "2026-09-22T00:00:30.000Z", failedStage: null, error: null, durationsMs: {} });
const options = (recordId, lyrics) => ({ source: source(recordId, lyrics), buildId: "test", mode: "full", origin: "https://app.test", reporterNote: "" });
const draft = (api, generationId = "generation-one") => api.createEvaluationDraft({ generationId,
  createdAt: "2026-09-22T00:00:10.000Z", candidates: [candidate(), candidate("candidate-b")], displayOrder: ["candidate-a", "candidate-b"],
  drawingAnalysis: { schemaVersion: 1, objectCandidates: [{ label: "ねこ", confidence: "high" }], parts: [], drawingOrder: [] },
  modelInfo: { drawingAnalysis: "vision", lyricsGeneration: "lyrics" }, lyricsPromptVersion: null, activeCandidateId: "candidate-a" });

test("debug ZIP roundtrips single/AB selected candidates and legacy lyrics, with and without voice", async () => {
  const api = fresh();
  for (const candidateId of ["candidate-a", "candidate-b", null]) {
    const lyrics = candidate(candidateId);
    if (!candidateId) delete lyrics.candidateId;
    for (const voice of [false, true]) {
      const input = options(`zip-${candidateId}-${voice}`, lyrics);
      if (voice) Object.assign(input.source, { voiceAudioBlob: new Blob(["RIFF0000WAVE"]), playbackKind: "voice", voicevoxStatus: "voice" });
      const exported = await api.createDebugBundle(input);
      const imported = await api.importDebugBundle(exported.blob);
      assert.deepEqual(imported.manifest.lyrics, lyrics);
      assert.deepEqual(imported.manifest.drawing, exported.manifest.drawing);
      assert.equal(imported.voiceAudioBlob !== null, voice);
      const reexported = await api.createDebugBundleFromArtifacts({ artifacts: imported, reporterNote: "再保存" });
      assert.deepEqual((await api.importDebugBundle(reexported.blob)).manifest.lyrics, lyrics);
    }
  }
});

test("ZIP candidate compatibility keeps the strict field/value allowlist", async () => {
  const api = fresh();
  for (const lyrics of [{ ...candidate(), candidateId: "candidate-c" }, { ...candidate(), secret: "unexpected" }, { ...candidate(), candidateId: null }]) {
    const exported = await api.createDebugBundle(options("invalid", lyrics));
    await assert.rejects(api.importDebugBundle(exported.blob), /lyrics/);
  }
});

test("record save, delete and clear include drafts atomically and preserve anonymous generation counts", async () => {
  const api = fresh();
  const one = await api.buildDebugBundleArtifacts(options("record-one")), two = await api.buildDebugBundleArtifacts(options("record-two"));
  const firstDraft = draft(api), secondDraft = draft(api, "generation-two");
  await api.recordBrowserGeneration("record-one", source().startedAt);
  await api.saveDebugHistoryRecord(one, { evaluationDraft: firstDraft });
  await api.saveDebugHistoryRecord(two, { evaluationDraft: secondDraft });
  await api.setDebugHistoryFavorite("record-two", true);
  const counts = await api.getBrowserUsageStats();
  const records = await api.listDebugHistoryRecords();
  assert.ok((await api.getDebugHistoryStats()).storedBytes > records.reduce((sum, entry) => sum + entry.byteSize, 0));
  await api.deleteDebugHistoryRecord("record-one");
  assert.equal(await api.getEvaluationDraft("generation-one"), null);
  assert.deepEqual(await api.getEvaluationDraft("generation-two"), secondDraft);
  assert.equal((await api.getDebugHistoryRecord("record-two")).isFavorite, true);
  await api.clearDebugHistoryRecords();
  assert.equal(await api.getEvaluationDraft("generation-two"), null);
  assert.equal((await api.getDebugHistoryStats()).storedBytes, 0);
  assert.deepEqual(await api.getBrowserUsageStats(), counts);
});

test("late voice saves and evaluation edits cannot resurrect deleted work or overwrite newer ratings", async () => {
  const api = fresh(), initial = draft(api);
  const artifacts = await api.buildDebugBundleArtifacts(options("record-one"));
  await api.saveDebugHistoryRecord(artifacts, { evaluationDraft: initial });
  assert.equal(await api.saveEvaluationDraft({ ...initial, updatedAt: "2026-09-22T00:02:00.000Z", ratings: { singability: "good" } }), true);
  await api.saveDebugHistoryRecord(artifacts, { evaluationDraft: initial, onlyIfExisting: true });
  assert.deepEqual((await api.getEvaluationDraft(initial.generationId)).ratings, { singability: "good" });
  await Promise.all([api.deleteDebugHistoryRecord("record-one"), api.saveEvaluationDraft({ ...initial, updatedAt: "2026-09-22T00:03:00.000Z" })]);
  assert.equal(await api.saveDebugHistoryRecord(artifacts, { evaluationDraft: initial, onlyIfExisting: true }), null);
  assert.equal(await api.saveEvaluationDraft(initial), false);
  assert.equal(await api.updateEvaluationDraftState(initial.generationId, { alternativePreviewed: true }, "2026-09-22T00:04:00.000Z"), false);
  assert.equal(await api.getEvaluationDraft(initial.generationId), null);
  assert.equal((await api.listDebugHistoryRecords()).length, 0);
});

test("failed media storage rolls back both record and evaluation draft", async t => {
  const api = fresh(), initial = draft(api);
  const artifacts = await api.buildDebugBundleArtifacts(options("record-one"));
  const put = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, "put", function (...args) {
    if (this.name === "assets") throw new DOMException("Simulated full disk", "QuotaExceededError");
    return put.apply(this, args);
  });
  await assert.rejects(api.saveDebugHistoryRecord(artifacts, { evaluationDraft: initial }), error => error.code === "quota");
  assert.equal(await api.getEvaluationDraft(initial.generationId), null);
  assert.equal((await api.listDebugHistoryRecords()).length, 0);
});

test("legacy drafts migrate only to matching saved works and orphan copies are removed", async () => {
  const api = fresh();
  const artifacts = await api.buildDebugBundleArtifacts(options("legacy-record"));
  const opening = globalThis.indexedDB.open("cho-ekaki-uta-debug-history", 3);
  opening.onupgradeneeded = () => {
    for (const store of ["records", "assets", "images", "generations"]) opening.result.createObjectStore(store, { keyPath: "recordId" });
  };
  const history = await request(opening), transaction = history.transaction(["records", "assets", "images", "generations"], "readwrite");
  transaction.objectStore("records").put({ recordId: "legacy-record", createdAt: artifacts.manifest.createdAt, manifest: artifacts.manifest, byteSize: 300, isFavorite: true });
  transaction.objectStore("assets").put({ recordId: "legacy-record", voiceAudioBlob: null });
  transaction.objectStore("images").put({ recordId: "legacy-record", imageBlob: artifacts.imageBlob, hasVoice: false });
  transaction.objectStore("generations").put({ recordId: "legacy-record", date: "2026-09-22", recorded: true });
  await done(transaction); history.close();
  const legacyOpening = globalThis.indexedDB.open("cho-ekaki-uta-evaluation-drafts", 1);
  legacyOpening.onupgradeneeded = () => legacyOpening.result.createObjectStore("drafts", { keyPath: "generationId" });
  const legacy = await request(legacyOpening), saving = legacy.transaction("drafts", "readwrite");
  const matching = draft(api, "old-generation"), orphan = { ...draft(api, "deleted-generation"), createdAt: "2026-09-21T00:00:10.000Z" };
  saving.objectStore("drafts").put(matching);
  saving.objectStore("drafts").put(orphan);
  await done(saving); legacy.close();
  assert.deepEqual(await api.getEvaluationDraft(matching.generationId), matching);
  assert.equal(await api.getEvaluationDraft(orphan.generationId), null);
  const migratedLegacy = await request(globalThis.indexedDB.open("cho-ekaki-uta-evaluation-drafts", 2));
  const checking = migratedLegacy.transaction("drafts", "readonly");
  assert.equal(await request(checking.objectStore("drafts").count()), 0);
  await done(checking); migratedLegacy.close();
  assert.equal((await api.getDebugHistoryRecord("legacy-record")).isFavorite, true);
  const counts = await api.getBrowserUsageStats();
  await api.deleteDebugHistoryRecord("legacy-record");
  assert.equal(await api.getEvaluationDraft(matching.generationId), null);
  assert.deepEqual(await api.getBrowserUsageStats(), counts);
});

test("legacy version barrier reports an old open tab promptly and retry fences all old writers", async () => {
  const api = fresh();
  const legacyOpening = globalThis.indexedDB.open("cho-ekaki-uta-evaluation-drafts", 1);
  legacyOpening.onupgradeneeded = () => legacyOpening.result.createObjectStore("drafts", { keyPath: "generationId" });
  const oldTab = await request(legacyOpening);
  const saved = oldTab.transaction("drafts", "readwrite");
  saved.objectStore("drafts").put(draft(api));
  await done(saved);
  await assert.rejects(api.clearDebugHistoryRecords(), /ほかのタブ/);
  // Blocked migration has neither hung nor silently erased a durable draft.
  const stillThere = oldTab.transaction("drafts", "readonly");
  assert.equal(await request(stillThere.objectStore("drafts").count()), 1);
  await done(stillThere);
  oldTab.close();
  await api.clearDebugHistoryRecords();
  await assert.rejects(request(globalThis.indexedDB.open("cho-ekaki-uta-evaluation-drafts", 1)), error => error.name === "VersionError");
  const retired = await request(globalThis.indexedDB.open("cho-ekaki-uta-evaluation-drafts", 2));
  const checking = retired.transaction("drafts", "readonly");
  assert.equal(await request(checking.objectStore("drafts").count()), 0);
  await done(checking); retired.close();
});

test("an old tab cannot create a new legacy database after unified storage was initialized", async () => {
  const api = fresh();
  await api.listDebugHistoryRecords();
  await assert.rejects(request(globalThis.indexedDB.open("cho-ekaki-uta-evaluation-drafts", 1)), error => error.name === "VersionError");
});

test("record limits also reject the draft without leaving an orphan", async () => {
  const api = fresh();
  for (let index = 0; index < api.DEBUG_HISTORY_MAX_RECORDS; index++) {
    await api.saveDebugHistoryRecord(await api.buildDebugBundleArtifacts(options(`limit-${index}`)));
  }
  const initial = draft(api, "over-limit");
  await assert.rejects(api.saveDebugHistoryRecord(await api.buildDebugBundleArtifacts(options("overflow")), { evaluationDraft: initial }), error => error.code === "record-limit");
  assert.equal(await api.getEvaluationDraft(initial.generationId), null);
  assert.equal((await api.listDebugHistoryRecords()).length, api.DEBUG_HISTORY_MAX_RECORDS);
});
