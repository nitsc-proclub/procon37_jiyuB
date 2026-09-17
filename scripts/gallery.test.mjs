import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true }, appType: "custom" });
after(() => vite.close());
const gallery = await vite.ssrLoadModule("/gallery/model.ts");
const timing = await vite.ssrLoadModule("/utils/playbackTiming.ts");
const record = (id, date = "2026-09-17", audio = true) => ({ recordId: id, savedAt: date, title: id, audioUrl: audio ? `/audio/${id}` : null });

test("gallery keeps only recorded audio, sorts newest first and does not mutate the management list", () => {
  const input = [record("old", "2026-09-01"), record("silent", "2026-09-18", false), record("new", "2026-09-17"), record("old", "2026-09-01")];
  assert.deepEqual(gallery.galleryRecords(input).map(r => r.recordId), ["new", "old"]);
  assert.equal(input.length, 4);
  assert.equal(input[1].recordId, "silent");
});

test("new arrivals keep the selected work, while deletion selects the neighboring work", () => {
  const old = [record("b"), record("c"), record("d")];
  const next = [record("a"), ...old];
  assert.equal(gallery.preserveSelection(old, next, "c"), "c");
  assert.equal(gallery.nextSelection(next, "c", 1), "d");
  assert.equal(gallery.nextSelection(next, "c", -1), "b");
  assert.equal(gallery.preserveSelection(old, [old[0], old[2]], "c"), "d");
  assert.equal(gallery.preserveSelection(old, [], "c"), null);
  assert.equal(gallery.nextSelection(next, "a", -1), "a");
  assert.equal(gallery.nextSelection(next, "d", 1), "d");
});

test("card personality stays attached to ID across updates and remains within agreed limits", () => {
  for (let index = 0; index < 1000; index++) {
    const a = gallery.cardTraits(`work-${index}`);
    gallery.cardTraits(`other-${index}`);
    assert.deepEqual(gallery.cardTraits(`work-${index}`), a);
    assert.ok(Math.abs(a.x) <= 20 && Math.abs(a.y) <= 25 && Math.abs(a.rotation) <= 1);
    assert.ok(a.amplitude >= 6 && a.amplitude <= 12);
    assert.ok(a.duration >= 6 && a.duration <= 11);
  }
});

test("eight complete cards fit a landscape viewport, with room for float and selection enlargement", () => {
  for (const [width, height] of [[1920, 1080], [1280, 720], [1366, 768], [2560, 1440]]) {
    const layout = gallery.galleryLayout(width, height);
    assert.equal(layout.columns, 4);
    for (let sample = 0; sample < 100; sample++) {
      const cards = Array.from({ length: 8 }, (_, index) => {
        const position = gallery.cardPosition(index, `work-${sample}-${index}`, layout);
        // Includes rotation, selection enlargement and float extrema.
        const horizontalMargin = layout.cardWidth * .026;
        const verticalMargin = horizontalMargin + 12 * layout.scale;
        return { left: position.left - horizontalMargin, right: position.left + layout.cardWidth + horizontalMargin,
          top: position.top - verticalMargin, bottom: position.top + layout.cardHeight + verticalMargin };
      });
      for (let i = 0; i < cards.length; i++) {
        const a = cards[i];
        assert.ok(a.left >= 0 && a.top >= 0 && a.right <= width && a.bottom <= height, `${width}x${height}: clipped ${i}`);
        for (const b of cards.slice(i + 1)) assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, "cards overlap");
      }
    }
  }
});

test("idle tour ends at work 32 regardless of total history; manual content retains all works", () => {
  const layout = gallery.galleryLayout(1920, 1080);
  assert.equal(gallery.tourEnd(700, layout), gallery.tourEnd(32, layout));
  assert.equal(gallery.tourEnd(32, layout), 3 * 1080);
  assert.ok(gallery.contentHeight(700, layout) > gallery.contentHeight(32, layout));
  assert.equal(gallery.tourEnd(0, layout), 0);
  assert.equal(gallery.tourEnd(8, layout), 0);
  assert.equal(gallery.tourEnd(9, layout), 540);
});

test("device keys follow the agreed layout without overriding browser shortcuts or assigning volume keys", () => {
  const event = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  for (const [key, action] of [["ArrowRight", "next"], ["ArrowLeft", "previous"], ["Enter", "confirm"],
    ["Escape", "back"], ["r", "refresh"], ["R", "refresh"], [" ", "togglePlayback"]]) {
    assert.equal(gallery.keyAction({ ...event, key }), action);
    for (const modifier of ["ctrlKey", "altKey", "shiftKey", "metaKey"]) {
      assert.equal(gallery.keyAction({ ...event, key, [modifier]: true }), undefined);
    }
  }
  for (const key of ["ArrowUp", "ArrowDown", "+", "-", "AudioVolumeUp", "AudioVolumeDown", "Tab"]) {
    assert.equal(gallery.keyAction({ ...event, key }), undefined);
  }
  assert.ok(!gallery.GALLERY_KEY_BINDINGS.some(binding => binding.action.startsWith("volume")));
});

test("pencil line remains a single connected path across a window of rows", () => {
  const layout = gallery.galleryLayout(1920, 1080);
  for (const row of [0, 7, 99]) {
    const path = gallery.pencilPath(row, row + 3, layout);
    assert.equal((path.match(/M /g) ?? []).length, 1);
    assert.ok(path.endsWith(`${layout.padding + (row + 4) * layout.rowHeight}`));
    assert.ok(!path.includes("NaN"));
  }
});

test("maker and gallery share timing: fallback drawing completes at the final lyric line", () => {
  const lyrics = { lines: ["a", "b", "c", "d"], singingKanaLines: ["あ", "い", "う", "え"] };
  const score = { notes: [{ key: null, lyric: "", frame_length: 10 }, ...["あ", "い", "う", "え"].map(lyric => ({key: 60, lyric, frame_length: 100}))] };
  assert.equal(timing.getSingingLineCount(lyrics), 4);
  assert.equal(timing.getDrawingAnimationEndProgress(lyrics, score), 310 / 410);
  assert.equal(timing.getDrawingAnimationEndProgress(lyrics, null), 1);
  assert.equal(timing.getSingingLineCount({ lines: ["a", "", "b"] }), 2);
});
