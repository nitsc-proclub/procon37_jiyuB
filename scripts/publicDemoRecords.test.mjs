import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { indexedDB, IDBObjectStore } from "fake-indexeddb";

test("public demos retain browser saves, favorites, opening and deletion without ZIP or generation controls", async t => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://app.test", pretendToBeVisual: true });
  const { document } = dom.window;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, indexedDB, IS_REACT_ACT_ENVIRONMENT: true });
  t.mock.method(globalThis, "fetch", () => assert.fail("Demo browsing must stay in the browser"));
  let audioReads = 0;
  const original = IDBObjectStore.prototype.get;
  t.mock.method(IDBObjectStore.prototype, "get", function (...args) {
    if (this.name === "assets") audioReads++;
    return original.apply(this, args);
  });
  const compiled = await build({ stdin: { contents: 'export * as React from "react"; export { createRoot } from "react-dom/client"; export { default as View } from "./components/PublicDemoRecordsView"; export * from "./services/debugHistoryDb";', resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external", define: { "import.meta.env": "{}" } });
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const api = module.exports;
  for (const recordId of ["ねこのうた", "くまのうた"]) await api.saveDebugHistoryRecord({
    manifest: { recordId, createdAt: "2026-10-01T00:00:00Z", generation: { startedAt: "2026-10-01T00:00:00Z" },
      drawing: { strokes: [], strokeGroups: [] }, lyrics: { title: recordId, identifiedObject: "ねこ", lines: ["まる"], singingKanaLines: ["まる"] },
      singingScore: { notes: [{ lyric: "ま", key: 60, frame_length: 40 }] }, audio: { path: "voice.wav" } },
    imageBlob: new Blob(["image"]), voiceAudioBlob: new Blob(["RIFF0000WAVE"]),
  });
  const { React } = api;
  let root = api.createRoot(document.getElementById("root"));
  const opened = [], toasts = [];
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await React.act(() => new Promise(resolve => setTimeout(resolve, 5)));
      if (!document.querySelector('[role="status"]')) return;
    }
    assert.fail("Demo refresh did not complete");
  };
  const render = async () => { await React.act(async () => { root.render(React.createElement(api.View, { onOpenRecord: r => opened.push(r), onToast: m => toasts.push(m) })); }); await settle(); };
  const button = label => document.querySelector(`button[aria-label="${label}"]`) ?? [...document.querySelectorAll("button")].find(b => b.textContent === label);
  const click = async label => { const target = button(label); assert.ok(target, label); await React.act(async () => { target.click(); await new Promise(resolve => setTimeout(resolve, 20)); }); await settle(); };
  try {
    await render();
    assert.equal(audioReads, 0, "Lists do not load voice blobs");
    assert.equal(document.querySelectorAll('[role="progressbar"]').length, 2);
    assert.equal(document.querySelector('[aria-label="保存件数"]').getAttribute("aria-valuenow"), "2");
    for (const text of ["生成回数", "ZIP", "Browser-only", "このブラウザ", "保存するかは", "ブラウザ全体", "メーカーへ戻る", "すべて削除"]) assert.ok(!document.body.textContent.includes(text), text);
    await click("ねこのうたのお気に入り");
    assert.equal((await api.getDebugHistoryRecord("ねこのうた")).isFavorite, true);
    await React.act(() => root.unmount());
    root = api.createRoot(document.getElementById("root"));
    await render();
    assert.equal(button("ねこのうたのお気に入り").getAttribute("aria-pressed"), "true");
    await click("★ お気に入りのみ");
    assert.ok(button("ねこのうたを開く")); assert.equal(button("くまのうたを開く"), undefined);
    await click("歌の一覧");
    await click("ねこのうたを開く");
    assert.equal(opened[0].artifacts.voiceAudioBlob.size, 12);
    dom.window.confirm = () => false;
    await click("ねこのうたを削除");
    assert.ok(await api.getDebugHistoryRecord("ねこのうた"));
    dom.window.confirm = () => true;
    await click("ねこのうたを削除");
    assert.equal(await api.getDebugHistoryRecord("ねこのうた"), null);
    assert.match(document.body.textContent, /お気に入りはありません/);
    assert.equal(toasts.length, 1);
    await click("★ お気に入りのみ");
    assert.ok(button("くまのうたを開く"));
    await click("更新");
    assert.equal(document.querySelector('[aria-label="保存件数"]').getAttribute("aria-valuenow"), "1");
  } finally { await React.act(() => root.unmount()); dom.window.close(); }
});
