import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";

const loader = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true }, appType: "custom" });
const { createDemoRecordEventHub } = await loader.ssrLoadModule("/server/demoRecordEvents.ts");
const { createDemoRecordMiddleware } = await loader.ssrLoadModule("/vite.config.ts");
const { createSilentPlaybackAudio } = await loader.ssrLoadModule("/services/silentPlaybackService.ts");
const { saveDemoRecord } = await loader.ssrLoadModule("/services/demoRecordService.ts");
test.after(() => loader.close());

const fixture = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ekaki-record-safety-"));
  const root = path.join(directory, "records");
  const outside = path.join(directory, "outside");
  await Promise.all([fs.mkdir(root), fs.mkdir(outside)]);
  await fs.writeFile(path.join(outside, "keep.txt"), "outside must survive");
  const hub = createDemoRecordEventHub();
  const middleware = createDemoRecordMiddleware(root, "test", hub);
  const server = createHttpServer((request, response) => {
    void middleware(request, response, () => { response.statusCode = 404; response.end(); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const request = (suffix = "", method = "GET", body, headers = {}, apiPrefix = "/api/demo-records") => new Promise((resolve, reject) => {
    // Keep raw dot segments and escapes intact; fetch/URL would normalize them.
    const rawPath = Array.from(`${apiPrefix}${suffix}`, (character) => character.codePointAt(0) > 127 ? encodeURIComponent(character) : character).join("");
    const request = httpRequest({ hostname: "127.0.0.1", port, path: rawPath, method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: response.statusCode, bytes, text: bytes.toString(), json: () => JSON.parse(bytes.toString()) });
      });
    });
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  t.after(async () => {
    hub.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith("ekaki-record-safety-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { root, outside, request, origin };
};

const payload = () => ({ imageDataUri: "data:image/png;base64,aW1hZ2U=", audioDataUri: "data:audio/wav;base64,YXVkaW8=",
  metadata: { status: "success", lyrics: { title: "保存テスト", identifiedObject: "まる", lines: ["まる"] }, drawing: { strokes: [] },
    singingScore: { notes: [{ lyric: "ま", key: 60, frame_length: 90 }] } } });
const createRecord = async (request, body = payload()) => {
  const result = await request("", "POST", body);
  assert.equal(result.status, 201, result.text);
  return result.json().recordId;
};

test("malformed and traversal paths never read, update, or delete the records root", async (t) => {
  const { root, outside, request } = await fixture(t);
  const id = await createRecord(request);
  for (const suffix of ["/%2e%2f", "/%2e%5c", "/.", "/..", "/%2e%2e", "/%2f", "/%5c", "/%2e%2e%2foutside", "/%2e%2e%5coutside", "/%00", "/%", "/%E0%A4%A", "//", "/con", "/record.", "/record%20", "/C%3a"]) {
    for (const method of ["GET", "DELETE", "PATCH"]) {
      const response = await request(suffix, method, method === "PATCH" ? { favorite: true } : undefined);
      assert.equal(response.status, 400, `${method} ${suffix}: ${response.text}`);
    }
  }
  assert.equal((await request("", "GET", undefined, {}, "/api/demo-records-other")).status, 404);
  assert.equal((await request(`/${id}`)).status, 200);
  assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "outside must survive");
  assert.deepEqual(await fs.readdir(root), [id]);
  assert.equal((await request(`/${id}`, "DELETE")).status, 200);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal((await request(`/${id}`, "DELETE")).status, 200, "safe deletion remains idempotent");
});

test("foreign origins and browser cross-site requests cannot mutate local records; same-origin LAN hosts work", async (t) => {
  const { request, origin } = await fixture(t);
  const id = await createRecord(request);
  for (const headers of [{ Origin: "https://foreign.example" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }]) {
    for (const [suffix, method, body] of [[`/${id}`, "DELETE"], [`/${id}`, "PATCH", { favorite: true }], ["", "POST", payload()], ["/stats", "POST", { recorded: false }], ["", "GET"]]) {
      assert.equal((await request(suffix, method, body, headers)).status, 403);
    }
  }
  assert.equal((await request("", "POST", payload(), { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await request(`/${id}`, "PATCH", { favorite: true }, { Origin: origin, "Sec-Fetch-Site": "same-origin" })).status, 200);
  const lan = { Host: "192.168.10.2:3000", Origin: "http://192.168.10.2:3000", "Sec-Fetch-Site": "same-origin" };
  assert.equal((await request(`/${id}`, "PATCH", { favorite: false }, lan)).status, 200);
  assert.equal((await request(`/${id}`, "GET")).json().isFavorite, false);
});

test("record junctions, metadata links, and metadata-selected traversal files stay outside the API", async (t) => {
  const { root, outside, request } = await fixture(t);
  const id = await createRecord(request);
  const link = path.join(root, "outside-link");
  await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  for (const method of ["GET", "DELETE", "PATCH"]) {
    assert.equal((await request("/outside-link", method, method === "PATCH" ? { favorite: true } : undefined)).status, 400);
  }
  const metadataPath = path.join(root, id, "metadata.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  metadata.files.image = "../../outside/keep.txt";
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  assert.equal((await request(`/${id}/image`)).status, 400);
  const insideLink = path.join(root, id, "linked-image");
  await fs.symlink(outside, insideLink, process.platform === "win32" ? "junction" : "dir");
  metadata.files.image = "linked-image/keep.txt";
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  assert.equal((await request(`/${id}/image`)).status, 400);
  await fs.rm(metadataPath);
  // A directory junction works without Windows symlink privileges and must not be treated as JSON.
  await fs.symlink(outside, metadataPath, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await request(`/${id}`)).status, 400);
  assert.equal((await request(`/${id}`, "PATCH", { favorite: true })).status, 400);
  assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "outside must survive");
});

test("server-owned paths override supplied metadata and only actual voice audio is advertised", async (t) => {
  const { root, request } = await fixture(t);
  const body = payload();
  body.metadata.files = { image: "../../outside/keep.txt", audio: "../../outside/keep.txt" };
  body.metadata.recordId = "fake-id";
  body.metadata.savedAt = "fake-time";
  body.metadata.mimeTypes = { image: "text/html" };
  const voiceId = await createRecord(request, body);
  const voice = (await request(`/${voiceId}`)).json();
  assert.equal(voice.playbackKind, "voice");
  assert.equal(voice.hasAudio, true);
  assert.equal(voice.recordId, voiceId);
  assert.notEqual(voice.savedAt, "fake-time");
  assert.equal((await request(`/${voiceId}/image`)).text, "image");
  assert.equal((await request(`/${voiceId}/audio`)).text, "audio");
  for (const useSilentBlob of [false, true]) {
    const fallback = payload();
    if (useSilentBlob) fallback.audioDataUri = `data:audio/wav;base64,${Buffer.from(await createSilentPlaybackAudio(fallback.metadata.singingScore).arrayBuffer()).toString("base64")}`;
    else fallback.metadata.playbackKind = "animation-only";
    const id = await createRecord(request, fallback);
    const detail = (await request(`/${id}`)).json();
    assert.equal(detail.playbackKind, "animation-only");
    assert.equal(detail.hasAudio, false);
    assert.equal(detail.audioUrl, null);
    assert.deepEqual(detail.singingScore, fallback.metadata.singingScore);
    assert.equal((await request(`/${id}/audio`)).status, 404);
    assert.deepEqual((await fs.readdir(path.join(root, id))).sort(), ["input.png", "metadata.json"]);
  }
  const records = (await request()).json().records;
  assert.equal(records.filter((record) => record.hasAudio).length, 1);
});

test("legacy saved silent clocks become animation-only without modifying existing files or genuine recordings", async (t) => {
  const { root, request } = await fixture(t);
  const legacyVoice = await createRecord(request);
  const legacySilent = await createRecord(request);
  const almostSilent = await createRecord(request);
  const silence = Buffer.from(await createSilentPlaybackAudio(payload().metadata.singingScore).arrayBuffer());
  for (const id of [legacyVoice, legacySilent, almostSilent]) {
    const metadataPath = path.join(root, id, "metadata.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    delete metadata.playbackKind;
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    if (id !== legacyVoice) {
      const audio = Buffer.from(silence);
      if (id === almostSilent) audio[audio.length - 1] = 1;
      await fs.writeFile(path.join(root, id, "voice.wav"), audio);
    }
  }
  const before = await fs.readFile(path.join(root, legacySilent, "metadata.json"));
  const records = (await request()).json().records;
  assert.equal(records.find((record) => record.recordId === legacySilent).hasAudio, false);
  assert.equal(records.find((record) => record.recordId === legacyVoice).hasAudio, true);
  assert.equal(records.find((record) => record.recordId === almostSilent).hasAudio, true);
  assert.equal((await request(`/${legacySilent}`)).json().playbackKind, "animation-only");
  assert.equal((await request(`/${legacySilent}/audio`)).status, 404);
  assert.equal((await request(`/${legacyVoice}/audio`)).text, "audio");
  assert.deepEqual(await fs.readFile(path.join(root, legacySilent, "metadata.json")), before);
  assert.deepEqual(await fs.readFile(path.join(root, legacySilent, "voice.wav")), silence);
});

test("client excludes animation clocks from local saves even when supplied a Blob", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ recordId: "saved", directory: "fixture" }), { status: 201 });
  });
  await saveDemoRecord({ drawingData: { imageUri: "data:image/png;base64,aW1hZ2U=", strokes: [] }, lyrics: payload().metadata.lyrics,
    audioBlob: new Blob(["silent clock"]), playbackKind: "animation-only", singingScore: payload().metadata.singingScore,
    error: null, startedAt: "2026-09-22T00:00:00Z", participantAge: null, aiModel: "test" });
  assert.equal(bodies[0].audioDataUri, null);
  assert.equal(bodies[0].metadata.playbackKind, "animation-only");
  assert.equal(bodies[0].metadata.status, "success", "successful lyrics and drawing remain available");
});
