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

const { React, createRoot, Panel } = await compile('export * as React from "react"; export { createRoot } from "react-dom/client"; export { default as Panel } from "./components/KaraokeLyricsPanel";');
test("karaoke renders only visible changes and preserves seek, pause, end and line clicks", async () => {
  const frames = new Map(); let sequence = 0, commits = 0;
  dom.window.requestAnimationFrame = fn => { frames.set(++sequence, fn); return sequence; };
  dom.window.cancelAnimationFrame = id => frames.delete(id);
  const audio = document.createElement("audio");
  Object.defineProperties(audio, { duration: { value: 20 }, paused: { value: false, writable: true } });
  audio.play = async () => { audio.paused = false; audio.dispatchEvent(new Event("play")); };
  const root = createRoot(document.getElementById("root"));
  const lyrics = { lines: ["あいうえ", "かきくけ"], title: "test" };
  await React.act(async () => root.render(React.createElement(React.Profiler, { id: "lyrics", onRender: () => commits++ }, React.createElement(Panel, { lyrics, audioRef: { current: audio } }))));
  const frame = async time => { audio.currentTime = time; await React.act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); }); };
  await frame(.1);
  const settled = commits;
  for (let i = 0; i < 60; i++) await frame(.1 + i / 100);
  assert.equal(commits, settled, "60 frames in the same highlighted character cause no React commits");
  await frame(3);
  assert.equal(commits, settled + 1);
  audio.currentTime = 12;
  await React.act(async () => audio.dispatchEvent(new Event("seeking")));
  assert.equal(document.querySelectorAll('button[aria-pressed="true"]')[0].textContent, "かきくけ");
  audio.paused = true;
  await React.act(async () => audio.dispatchEvent(new Event("pause")));
  assert.equal(frames.size, 0);
  await React.act(async () => document.querySelector('button').click());
  assert.ok(audio.currentTime < .1);
  assert.equal(document.querySelector('button').getAttribute("aria-pressed"), "true");
  audio.currentTime = 20;
  await React.act(async () => audio.dispatchEvent(new Event("ended")));
  assert.equal(frames.size, 0);
  assert.equal(document.querySelectorAll('button[aria-pressed="true"]')[0].textContent, "かきくけ");
  await React.act(async () => root.unmount());
});
