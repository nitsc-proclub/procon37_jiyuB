import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { indexedDB } from "fake-indexeddb";
import { createRequire } from "node:module";

const dom = new JSDOM("<div id='root'></div>", { url: "https://drawing.test", pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage,
  HTMLElement: window.HTMLElement, HTMLCanvasElement: window.HTMLCanvasElement, Image: window.Image,
  Event: window.Event, indexedDB, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  ResizeObserver: class { observe() {} disconnect() {} },
});
window.matchMedia = query => ({ media: query, matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLMediaElement.prototype.pause = () => {};
window.HTMLMediaElement.prototype.load = () => {};
const contexts = new WeakMap();
window.HTMLCanvasElement.prototype.getContext = function () {
  if (!contexts.has(this)) contexts.set(this, {
    paths: [], current: [], setTransform() {}, fillRect() { this.paths = []; }, clearRect() { this.paths = []; },
    beginPath() { this.current = []; }, moveTo(x, y) { this.current.push([x, y]); },
    lineTo(x, y) { this.current.push([x, y]); }, arc(x, y) { this.current.push([x, y]); },
    stroke() { this.paths.push(this.current); }, fill() { this.paths.push(this.current); }, drawImage() {},
  });
  return contexts.get(this);
};
window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1024, height: 1024 });
window.HTMLCanvasElement.prototype.setPointerCapture = () => {};
window.HTMLCanvasElement.prototype.hasPointerCapture = () => false;
window.HTMLCanvasElement.prototype.toDataURL = () => png;
const result = await build({ stdin: { contents: 'export * as React from "react"; export { createRoot } from "react-dom/client"; export { default as App } from "./App"; export { default as PaintCanvas } from "./components/PaintCanvas"; export * from "./services/debugHistoryDb"; export * from "./services/debugBundleService";', resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, format: "cjs", platform: "node", packages: "external",
  define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true }), "process.env.NODE_ENV": '"development"' },
});
const module = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { React, createRoot, App, PaintCanvas, saveDebugHistoryRecord, buildDebugBundleArtifacts, getDebugHistoryRecord } = module.exports;
const canvas = () => document.querySelector('canvas[aria-label="好きな絵を描くキャンバス"]');
const count = () => canvas().getContext("2d").paths.length;
const button = text => [...document.querySelectorAll("button")].find(el => el.textContent.trim() === text || el.getAttribute("aria-label") === text);
const click = async text => { const el = button(text); assert.ok(el, `button ${text}`); assert.equal(el.disabled, false); await React.act(async () => { el.click(); await new Promise(resolve => setTimeout(resolve, 25)); }); };
const settle = async () => { await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); };
const draw = async (x = 20) => {
  for (const [type, clientX, clientY] of [["pointerdown", x, 20], ["pointermove", x + 50, 50], ["pointerup", x + 50, 50]]) {
    const event = new window.MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
    Object.defineProperty(event, "pointerId", { value: 1 });
    await React.act(() => canvas().dispatchEvent(event));
  }
};

test("App keeps unfinished drawing and undo/redo across record navigation, and explicit clear starts clean", async () => {
  const root = createRoot(document.getElementById("root"));
  try {
    await React.act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(App))));
    await draw(); await draw(100); assert.equal(count(), 2);
    await click("ひとつ戻す"); assert.equal(count(), 1);
    await click("デモ記録"); await settle();
    assert.equal(canvas(), null);
    await click("メーカーへ戻る"); assert.equal(count(), 1);
    await click("ひとつ進める"); assert.equal(count(), 2);
    await click("ぜんぶ消す");
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const confirm = [...dialog.querySelectorAll("button")].find(el => el.textContent.includes("消す"));
    await React.act(() => confirm.click()); assert.equal(count(), 0);
    await click("デモ記録"); await settle(); await click("メーカーへ戻る");
    assert.equal(count(), 0); assert.equal(button("ひとつ戻す").disabled, true);
  } finally { await React.act(() => root.unmount()); }
});

test("App editing a browser record retains original strokes, then navigating retains the edited draft", async () => {
  const stroke = x => ({ points: [{ x, y: 20, timestamp: 1 }, { x: x + 50, y: 50, timestamp: 2 }], startTime: 1, endTime: 2 });
  const artifacts = await buildDebugBundleArtifacts({ source: { recordId: "drawing-edit-regression", drawingData: {
    imageUri: png, strokes: [stroke(20), stroke(100)], canvasSize: { width: 1024, height: 1024 },
  }, lyrics: { title: "編集テスト", identifiedObject: "いえ", lines: ["いえ"], singingKanaLines: ["いえ"] },
  singingScore: { notes: [{ key: 60, lyric: "い", frame_length: 100 }] }, voiceAudioBlob: null,
  playbackKind: "animation-only", voicevoxStatus: "unavailable", voicevoxIssue: null,
  startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), failedStage: null, error: null, durationsMs: {} },
  buildId: "test", mode: "full", origin: window.location.origin });
  await saveDebugHistoryRecord(artifacts);
  const root = createRoot(document.getElementById("root"));
  try {
    await React.act(() => root.render(React.createElement(App)));
    await click("デモ記録"); await settle();
    const record = [...document.querySelectorAll("button")].find(el => el.querySelector("p")?.textContent === "編集テスト");
    assert.ok(record); await React.act(() => record.click()); await settle();
    assert.equal(count(), 2);
    await draw(200); assert.equal(count(), 3, "editing must retain the two stored strokes");
    await click("ひとつ戻す"); assert.equal(count(), 2);
    await click("デモ記録"); await settle(); await click("メーカーへ戻る");
    assert.equal(count(), 2); await click("ひとつ進める"); assert.equal(count(), 3);
    assert.equal((await getDebugHistoryRecord("drawing-edit-regression")).manifest.drawing.strokes.length, 2, "editing does not mutate the saved original");
  } finally { await React.act(() => root.unmount()); }
});

test("a late image load cannot overwrite edits and a new drawing resets the previous undo history", async () => {
  const images = [];
  const originalImage = globalThis.Image;
  globalThis.Image = class { constructor() { images.push(this); this.naturalWidth = 1024; this.naturalHeight = 1024; } };
  const root = createRoot(document.getElementById("root"));
  const draftRef = { current: null };
  const source = { imageUri: "old.png", strokes: [{ points: [{ x: 20, y: 20, timestamp: 1 }], startTime: 1, endTime: 1 }] };
  const render = initialDrawing => React.act(() => root.render(React.createElement(PaintCanvas, { initialDrawing, draftRef, isGenerating: false, onComplete() {}, onClear() {} })));
  try {
    await render(source); await draw(300); assert.equal(count(), 2);
    await React.act(() => images[0].onload()); assert.equal(count(), 2);
    await click("ひとつ戻す"); assert.equal(count(), 1);
    await render({ imageUri: "new.png", strokes: [], canvasSize: { width: 1024, height: 1024 } });
    assert.equal(count(), 0); assert.equal(button("ひとつ進める").disabled, true);
  } finally { await React.act(() => root.unmount()); globalThis.Image = originalImage; }
});

test("legacy image dimensions finish loading after StrictMode and navigation before decode", async () => {
  const images = [];
  const originalImage = globalThis.Image;
  globalThis.Image = class { constructor() { images.push(this); this.naturalWidth = 1024; this.naturalHeight = 1024; } };
  const root = createRoot(document.getElementById("root"));
  const draftRef = { current: null };
  const initialDrawing = { imageUri: "legacy.png", strokes: [{ points: [{ x: 100, y: 100, timestamp: 1 }], startTime: 1, endTime: 1 }] };
  const render = visible => React.act(() => root.render(React.createElement(React.StrictMode, null,
    visible ? React.createElement(PaintCanvas, { initialDrawing, draftRef, isGenerating: false, onComplete() {}, onClear() {} }) : null)));
  try {
    await render(true); await render(false); await render(true);
    const pending = images.find(image => typeof image.onload === "function");
    assert.ok(pending, "source decode resumes after cleanup");
    await React.act(() => pending.onload());
    assert.equal(draftRef.current.strokes[0].points[0].x, 100);
    await render(false); await render(true);
    assert.equal(draftRef.current.strokes[0].points[0].x, 100);
  } finally { await React.act(() => root.unmount()); globalThis.Image = originalImage; }
});

test("an undone edit to an image-only source survives remount even before its preview loads", async () => {
  const originalImage = globalThis.Image;
  globalThis.Image = class {};
  const root = createRoot(document.getElementById("root"));
  const draftRef = { current: null };
  const initialDrawing = { imageUri: "slow-image.png", strokes: [], canvasSize: { width: 1024, height: 1024 } };
  const render = visible => React.act(() => root.render(visible
    ? React.createElement(PaintCanvas, { initialDrawing, draftRef, isGenerating: false, onComplete() {}, onClear() {} }) : null));
  try {
    await render(true); await draw(); await click("ひとつ戻す");
    await render(false); await render(true);
    assert.equal(count(), 0); await click("ひとつ進める"); assert.equal(count(), 1);
  } finally { await React.act(() => root.unmount()); globalThis.Image = originalImage; }
});
