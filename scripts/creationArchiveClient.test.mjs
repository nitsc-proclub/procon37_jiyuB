import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true }, appType: "custom" });
const archive = await vite.ssrLoadModule("/services/creationArchiveService.ts");
const generationId = "123e4567-e89b-42d3-a456-426614174000";
const archiveId = "123e4567-e89b-42d3-a456-426614174001";
const capability = "a".repeat(43);
const candidate = (candidateId) => ({ candidateId, title: candidateId, lines: ["まる"], singingKanaLines: ["まる"], identifiedObject: "まる", lineStrokeMappings: [{ lineIndex: 0, strokeGroupIds: ["g1"] }], modelName: "test-model" });
const snapshot = (voice = false) => ({
  drawingData: { imageUri: "/drawing.png", strokes: [{ points: [{ x: 1, y: 2, timestamp: 3 }], startTime: 3, endTime: 3 }], strokeGroups: [{ id: "g1", rawStrokeIndexes: [0], bounds: { minX: 1, minY: 2, maxX: 1, maxY: 2 }, startTime: 3, endTime: 3, length: 0 }] },
  drawingAnalysis: { schemaVersion: 1, objectCandidates: [{ label: "まる", confidence: "high" }], parts: [{ id: "p1", shape: "まる", position: "なか", strokeGroupIds: ["g1"] }], drawingOrder: ["p1"] },
  candidates: ["candidate-a", "candidate-b"].map((id) => ({ candidate: candidate(id), score: { notes: [{ lyric: "ま", key: 60, frame_length: 1 }] }, voiceAudioBlob: voice ? new Blob(["RIFF"], { type: "audio/wav" }) : null, voiceStatus: voice ? "voice" : "failed", voicevoxIssue: voice ? null : "unavailable", voicevoxServer: null })),
  displayOrder: ["candidate-a", "candidate-b"], activeCandidateId: "candidate-a", buildId: "test", mode: "full", createdAt: "2026-09-01T00:00:00.000Z", modelInfo: { drawingAnalysis: "model-a", lyricsGeneration: "model-b" }, lyricsPromptVersion: "v1",
});
const evaluation = { generationId, centralConsent: "accepted" };
const store = () => { const map = new Map(); return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), map }; };

test("archive uploads the literal drawing, candidates and manifest with bearer capabilities", async () => {
  const requests = []; const storage = store();
  const fetcher = async (url, init = {}) => {
    requests.push([String(url), init]);
    if (url === "/drawing.png") return new Response(new Blob(["png"], { type: "image/png" }));
    if (url === archive.CREATION_ARCHIVE_INIT_URL) {
      const body = JSON.parse(init.body); return Response.json({ archiveId, uploadCapability: capability, deleteCapability: capability, pendingExpiresAt: 1, expiresAt: 2, assets: body.assets.map((asset) => ({ name: asset.name, maxBytes: asset.bytes, contentType: asset.contentType })) });
    }
    return Response.json({ status: "complete" });
  };
  const result = await archive.startCreationArchive({ evaluation, generationTicket: "ticket", consentVersion: "creation-archive-v1", snapshot: snapshot() }, { fetcher, storage });
  assert.equal(result.status, "complete");
  assert.equal(requests.filter(([url]) => url.includes("/assets/")).length, 5);
  const drawingPut = requests.find(([url]) => url.endsWith("/assets/drawing-json"))[1];
  assert.equal(new TextDecoder().decode(drawingPut.body), JSON.stringify({ strokes: snapshot().drawingData.strokes, strokeGroups: snapshot().drawingData.strokeGroups }));
  const candidatePut = requests.find(([url]) => url.endsWith("/assets/candidate-a-json"))[1];
  assert.equal(new TextDecoder().decode(candidatePut.body), JSON.stringify(candidate("candidate-a")));
  assert.equal(candidatePut.headers.Authorization, `Bearer ${capability}`);
  assert.equal(candidatePut.headers["X-Content-SHA256"].length, 64);
  assert.equal(archive.listCreationArchiveEntries(storage)[0].status, "complete");
});

test("archive declares and uploads every real WAV body", async () => {
  const requests = []; const storage = store();
  const fetcher = async (url, init = {}) => {
    requests.push([String(url), init]);
    if (url === "/drawing.png") return new Response(new Blob(["png"], { type: "image/png" }));
    if (url === archive.CREATION_ARCHIVE_INIT_URL) { const body = JSON.parse(init.body); return Response.json({ archiveId, uploadCapability: capability, deleteCapability: capability, pendingExpiresAt: 1, expiresAt: 2, assets: body.assets.map((asset) => ({ name: asset.name, maxBytes: asset.bytes, contentType: asset.contentType })) }); }
    return Response.json({ status: "complete" });
  };
  const result = await archive.startCreationArchive({ evaluation, generationTicket: "ticket", consentVersion: "creation-archive-v1", snapshot: snapshot(true) }, { fetcher, storage });
  assert.equal(result.status, "complete");
  const init = JSON.parse(requests.find(([url]) => url === archive.CREATION_ARCHIVE_INIT_URL)[1].body);
  assert.deepEqual(init.assets.map((asset) => asset.name), ["input-image", "drawing-json", "candidate-a-json", "candidate-b-json", "candidate-a-wav", "candidate-b-wav", "manifest"]);
  const wavPuts = requests.filter(([url]) => url.endsWith("-wav"));
  assert.equal(wavPuts.length, 2);
  for (const [, request] of wavPuts) { assert.equal(request.headers["Content-Type"], "audio/wav"); assert.equal(new TextDecoder().decode(request.body), "RIFF"); }
});

test("one unavailable candidate does not discard the other real WAV", async () => {
  const requests = []; const storage = store(); const source = snapshot(true);
  source.candidates[1] = { ...source.candidates[1], voiceAudioBlob: null, voiceStatus: "failed" };
  const fetcher = async (url, init = {}) => {
    requests.push([String(url), init]);
    if (url === "/drawing.png") return new Response(new Blob(["png"], { type: "image/png" }));
    if (url === archive.CREATION_ARCHIVE_INIT_URL) { const body = JSON.parse(init.body); return Response.json({ archiveId, uploadCapability: capability, deleteCapability: capability, pendingExpiresAt: 1, expiresAt: 2, assets: body.assets.map((asset) => ({ name: asset.name, maxBytes: asset.bytes, contentType: asset.contentType })) }); }
    return Response.json({ status: "complete" });
  };
  const result = await archive.startCreationArchive({ evaluation, generationTicket: "ticket", consentVersion: "creation-archive-v1", snapshot: source }, { fetcher, storage });
  assert.equal(result.status, "complete");
  assert.equal(requests.filter(([url]) => url.endsWith("-wav")).length, 1);
  assert.ok(requests.some(([url]) => url.endsWith("candidate-a-wav")));
});

test("archive never starts uploads when a deletion receipt cannot persist", async () => {
  const requests = []; const storage = { getItem: () => null, setItem: () => { throw new Error("blocked"); } };
  const fetcher = async (url, init = {}) => {
    requests.push([String(url), init]);
    if (url === "/drawing.png") return new Response(new Blob(["png"], { type: "image/png" }));
    if (url === archive.CREATION_ARCHIVE_INIT_URL) { const body = JSON.parse(init.body); return Response.json({ archiveId, uploadCapability: capability, deleteCapability: capability, pendingExpiresAt: 1, expiresAt: 2, assets: body.assets.map((asset) => ({ name: asset.name, maxBytes: asset.bytes, contentType: asset.contentType })) }); }
    return Response.json({});
  };
  const result = await archive.startCreationArchive({ evaluation, generationTicket: "ticket", consentVersion: "creation-archive-v1", snapshot: snapshot(true) }, { fetcher, storage });
  assert.equal(result.status, "failed"); assert.ok(result.deletionReceipt);
  assert.equal(requests.filter(([url]) => url.includes("/assets/")).length, 0);
});

test.after(async () => vite.close());


test("one candidate archives the exact optimized JPEG with no phantom B assets", async () => {
  const source = snapshot(true), requests = [];
  source.candidates = source.candidates.slice(0, 1);
  source.displayOrder = ["candidate-a"];
  source.drawingAnalysis = null;
  source.drawingData.imageUri = "data:image/jpeg;base64,/9j/2Q==";
  const jpeg = new Uint8Array([255, 216, 255, 217]);
  const fetcher = async (url, init = {}) => {
    requests.push([String(url), init]);
    if (url === source.drawingData.imageUri) return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
    if (url === archive.CREATION_ARCHIVE_INIT_URL) {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.assets.map(a => a.name), ["input-image", "drawing-json", "candidate-a-json", "candidate-a-wav", "manifest"]);
      assert.equal(body.assets[0].contentType, "image/jpeg");
      return Response.json({ archiveId, uploadCapability: capability, deleteCapability: capability, pendingExpiresAt: 1, expiresAt: 2, assets: body.assets.map(a => ({ name: a.name, maxBytes: a.bytes, contentType: a.contentType })) });
    }
    return Response.json({ status: "complete" });
  };
  const result = await archive.startCreationArchive({ evaluation, generationTicket: "ticket", consentVersion: "creation-archive-v1", snapshot: source }, { fetcher, storage: store() });
  assert.equal(result.status, "complete", result.error);
  const uploaded = requests.find(([url]) => url.endsWith("/assets/input-image"))[1];
  assert.deepEqual(uploaded.body, jpeg);
});
