import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer as createHttpServer, get as httpGet } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer, loadConfigFromFile, preview } from "vite";

const loader = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true },
  appType: "custom",
});
const { createDemoRecordEventHub } = await loader.ssrLoadModule("/server/demoRecordEvents.ts");
const { createDemoRecordMiddleware } = await loader.ssrLoadModule("/vite.config.ts");
test.after(() => loader.close());

const waitFor = async (predicate, description) => {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const openEvents = async (baseUrl) => {
  const request = httpGet(`${baseUrl}/api/demo-records/events`);
  const [response] = await once(request, "response");
  const messages = [];
  let pending = "";
  let ended = false;
  response.setEncoding("utf8");
  response.on("data", (chunk) => {
    pending += chunk;
    for (let separator; (separator = pending.indexOf("\n\n")) !== -1;) {
      const frame = pending.slice(0, separator);
      pending = pending.slice(separator + 2);
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      messages.push({ event, data: data ? JSON.parse(data) : null, frame });
    }
  });
  response.on("close", () => { ended = true; });
  response.on("error", () => {});
  await waitFor(() => messages.some((message) => message.event === "ready"), "initial ready event");
  return {
    response,
    messages,
    get ended() { return ended; },
    changes: () => messages.filter((message) => message.event === "change").map((message) => message.data),
    close: () => request.destroy(),
  };
};

const fixture = async (t, { heartbeatMs = 15_000 } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ekaki-record-events-"));
  const hub = createDemoRecordEventHub(heartbeatMs);
  const middleware = createDemoRecordMiddleware(root, "test", hub);
  const server = createHttpServer((request, response) => {
    void middleware(request, response, () => {
      response.statusCode = 404;
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    hub.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, hub, baseUrl: `http://127.0.0.1:${server.address().port}` };
};

const createPayload = () => ({
  imageDataUri: "data:image/png;base64,aW1hZ2U=",
  audioDataUri: "data:audio/wav;base64,YXVkaW8=",
  metadata: {
    status: "success",
    lyrics: { title: "テストのうた", identifiedObject: "まる", lines: ["まるをかこう"] },
    drawing: { strokes: [] },
  },
});

const jsonRequest = (baseUrl, endpoint, method, body) => fetch(`${baseUrl}/api/demo-records${endpoint}`, {
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test("SSE announces ready on connect/reconnect, keeps the connection alive, and isolates server hubs", async (t) => {
  const first = await fixture(t, { heartbeatMs: 20 });
  const second = await fixture(t);
  const firstClient = await openEvents(first.baseUrl);
  const secondClient = await openEvents(second.baseUrl);
  t.after(firstClient.close);
  t.after(secondClient.close);
  assert.match(firstClient.response.headers["content-type"], /^text\/event-stream/);
  assert.equal(firstClient.response.headers["cache-control"], "no-cache, no-transform");
  assert.match(firstClient.messages[0].frame, /retry: 2000/);
  await waitFor(() => firstClient.messages.some((message) => message.frame === ": heartbeat"), "heartbeat");

  first.hub.publish({ kind: "created", recordId: "only-first-server" });
  await waitFor(() => firstClient.changes().length === 1, "first-server change");
  assert.deepEqual(secondClient.changes(), []);
  firstClient.close();
  await waitFor(() => firstClient.ended, "client disconnect");
  first.hub.publish({ kind: "deleted", recordId: "while-disconnected" });
  const reconnected = await openEvents(first.baseUrl);
  t.after(reconnected.close);
  assert.equal(reconnected.messages[0].event, "ready");
  assert.deepEqual(reconnected.changes(), []);
  first.hub.publish({ kind: "updated", recordId: "after-reconnect" });
  await waitFor(() => reconnected.changes().length === 1, "reconnected change");
  assert.deepEqual(reconnected.changes(), [{ kind: "updated", recordId: "after-reconnect" }]);
  assert.deepEqual(firstClient.changes(), [{ kind: "created", recordId: "only-first-server" }]);
});

test("create is announced only after image, audio, metadata and detail/list are readable; updates and deletion follow commits", async (t) => {
  const { root, baseUrl } = await fixture(t);
  const client = await openEvents(baseUrl);
  t.after(client.close);
  const created = await jsonRequest(baseUrl, "", "POST", createPayload());
  assert.equal(created.status, 201);
  const { recordId } = await created.json();
  await waitFor(() => client.changes().length === 1, "saved record notification");
  assert.deepEqual(client.changes(), [{ kind: "created", recordId }]);
  const metadata = JSON.parse(await fs.readFile(path.join(root, recordId, "metadata.json"), "utf8"));
  assert.equal(await fs.readFile(path.join(root, recordId, metadata.files.image), "utf8"), "image");
  assert.equal(await fs.readFile(path.join(root, recordId, metadata.files.audio), "utf8"), "audio");
  const listed = await (await fetch(`${baseUrl}/api/demo-records`)).json();
  assert.equal(listed.records[0].recordId, recordId);
  assert.equal((await fetch(`${baseUrl}/api/demo-records/${encodeURIComponent(recordId)}`)).status, 200);

  const updated = await jsonRequest(baseUrl, `/${encodeURIComponent(recordId)}`, "PATCH", { favorite: true });
  assert.equal(updated.status, 200);
  await waitFor(() => client.changes().length === 2, "updated record notification");
  assert.equal(JSON.parse(await fs.readFile(path.join(root, recordId, "metadata.json"), "utf8")).favorite, true);
  assert.deepEqual(client.changes()[1], { kind: "updated", recordId });

  const removed = await jsonRequest(baseUrl, `/${encodeURIComponent(recordId)}`, "DELETE");
  assert.equal(removed.status, 200);
  await waitFor(() => client.changes().length === 3, "deleted record notification");
  await assert.rejects(fs.access(path.join(root, recordId)), { code: "ENOENT" });
  assert.deepEqual(client.changes()[2], { kind: "deleted", recordId });
});

test("partial save failures and rejected mutations do not publish changes or list incomplete records", async (t) => {
  const { root, baseUrl } = await fixture(t);
  const client = await openEvents(baseUrl);
  t.after(client.close);
  const writeFile = fs.writeFile;
  fs.writeFile = async (filePath, ...args) => {
    if (String(filePath).startsWith(`${root}${path.sep}`) && path.basename(filePath) === "metadata.json") {
      throw new Error("Simulated metadata write failure");
    }
    return writeFile(filePath, ...args);
  };
  try {
    const result = await jsonRequest(baseUrl, "", "POST", createPayload());
    assert.equal(result.status, 500);
  } finally {
    fs.writeFile = writeFile;
  }
  const dirs = await fs.readdir(root);
  assert.equal(dirs.length, 1);
  assert.equal(await fs.readFile(path.join(root, dirs[0], "input.png"), "utf8"), "image");
  const list = await (await fetch(`${baseUrl}/api/demo-records`)).json();
  assert.deepEqual(list.records, []);
  assert.equal((await jsonRequest(baseUrl, "/missing", "PATCH", { favorite: "invalid" })).status, 400);
  assert.equal((await jsonRequest(baseUrl, "/missing", "PATCH", { favorite: true })).status, 404);
  assert.equal((await jsonRequest(baseUrl, "/events", "DELETE")).status, 405);
  assert.deepEqual(client.changes(), []);
});

test("a slow metadata commit stays invisible to subscribers until all writes finish", async (t) => {
  const { root, baseUrl } = await fixture(t);
  const client = await openEvents(baseUrl);
  t.after(client.close);
  let metadataStarted = false;
  let releaseMetadata;
  const metadataGate = new Promise((resolve) => { releaseMetadata = resolve; });
  const writeFile = fs.writeFile;
  fs.writeFile = async (filePath, ...args) => {
    if (String(filePath).startsWith(`${root}${path.sep}`) && path.basename(filePath) === "metadata.json") {
      metadataStarted = true;
      await metadataGate;
    }
    return writeFile(filePath, ...args);
  };
  const pendingSave = jsonRequest(baseUrl, "", "POST", createPayload());
  try {
    await waitFor(() => metadataStarted, "metadata write starts");
    const list = await (await fetch(`${baseUrl}/api/demo-records`)).json();
    assert.deepEqual(list.records, []);
    assert.deepEqual(client.changes(), []);
  } finally {
    releaseMetadata();
    fs.writeFile = writeFile;
  }
  const response = await pendingSave;
  assert.equal(response.status, 201);
  const { recordId } = await response.json();
  await waitFor(() => client.changes().length === 1, "notification follows metadata commit");
  assert.deepEqual(client.changes(), [{ kind: "created", recordId }]);
});

test("closing a hub ends streams and rejects new streams without late notifications", async (t) => {
  const { hub, baseUrl } = await fixture(t, { heartbeatMs: 20 });
  const client = await openEvents(baseUrl);
  t.after(client.close);
  hub.close();
  hub.close();
  hub.publish({ kind: "created", recordId: "too-late" });
  await waitFor(() => client.ended, "hub closes response");
  assert.deepEqual(client.changes(), []);
  assert.equal((await fetch(`${baseUrl}/api/demo-records/events`)).status, 503);
});

for (const mode of ["dev", "preview"]) {
  test(`${mode} server shuts down with an active SSE client and a fresh server sends ready`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `ekaki-events-${mode}-`));
    const previous = process.env.DEMO_RECORDS_DIR;
    process.env.DEMO_RECORDS_DIR = root;
    let plugin;
    try {
      const loaded = await loadConfigFromFile({ command: "serve", mode: "test" }, path.resolve("vite.config.ts"));
      plugin = loaded.config.plugins.find((entry) => entry.name === "local-api");
    } finally {
      if (previous === undefined) delete process.env.DEMO_RECORDS_DIR;
      else process.env.DEMO_RECORDS_DIR = previous;
    }
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const servers = [];
    t.after(async () => { for (const server of servers) await server.close(); });
    for (let i = 0; i < 2; i++) {
      const options = {
        configFile: false,
        envFile: false,
        plugins: [plugin],
        optimizeDeps: { noDiscovery: true },
        appType: "custom",
        logLevel: "silent",
        server: { host: "127.0.0.1", port: 0, hmr: false },
        preview: { host: "127.0.0.1", port: 0 },
      };
      const server = mode === "dev" ? await createServer(options) : await preview(options);
      servers.push(server);
      if (mode === "dev") await server.listen();
      const client = await openEvents(`http://127.0.0.1:${server.httpServer.address().port}`);
      t.after(client.close);
      await server.close();
      await waitFor(() => client.ended, `${mode} closes active client`);
      assert.deepEqual(client.changes(), []);
    }
  });
}
