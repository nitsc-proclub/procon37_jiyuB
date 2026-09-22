import type { DemoRecordSummary } from "../types";

export const GALLERY_SETTINGS = {
  idleAfterMs: 25_000,
  tourLimit: 32,
  screenTravelSeconds: 90,
  endPauseMs: 3_000,
  fadeMs: 420,
  introductionMs: 2_800,
  returnAfterMs: 5_000,
  reconcileEveryMs: 30_000,
  navigationIntervalMs: 180,
  selectionScrollMs: 180,
} as const;

export type GalleryAction = "next" | "previous" | "confirm" | "back" | "refresh" | "volumeUp" | "volumeDown" | "togglePlayback";
export type GalleryKeyBinding = { key: string; action: GalleryAction; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };

// Matches the one-handed device: clockwise sends Right, counterclockwise Left.
// Volume actions remain available without assigning any keys to them.
export const GALLERY_KEY_BINDINGS: readonly GalleryKeyBinding[] = [
  { key: "ArrowRight", action: "next" },
  { key: "ArrowLeft", action: "previous" },
  { key: "Enter", action: "confirm" },
  { key: "Escape", action: "back" },
  { key: "r", action: "refresh" },
  { key: " ", action: "togglePlayback" },
];
export const GALLERY_ACTION_EVENT = "ekaki-gallery-action";
export const GALLERY_ACTIONS: readonly GalleryAction[] = ["next", "previous", "confirm", "back", "refresh", "volumeUp", "volumeDown", "togglePlayback"];

export function keyAction(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">, bindings = GALLERY_KEY_BINDINGS) {
  return bindings.find(binding => binding.key.toLowerCase() === event.key.toLowerCase()
    && !!binding.ctrl === event.ctrlKey && !!binding.alt === event.altKey
    && !!binding.shift === event.shiftKey && !!binding.meta === event.metaKey)?.action;
}

// Leading-edge throttle: react immediately, then discard duplicate rotary pulses.
// Ignored pulses never extend the window or queue a delayed move. A direction
// reversal is always immediate so visitors can correct an overshoot.
export function createNavigationInputFilter(intervalMs = GALLERY_SETTINGS.navigationIntervalMs) {
  let previous: "next" | "previous" | null = null;
  let acceptedAt = -Infinity;
  return (action: GalleryAction, now: number) => {
    if (action !== "next" && action !== "previous") {
      previous = null;
      return true;
    }
    if (action === previous && now - acceptedAt < intervalMs) return false;
    previous = action;
    acceptedAt = now;
    return true;
  };
}

export function galleryRecords(records: DemoRecordSummary[]) {
  return [...new Map(records.filter(record => record.hasAudio ?? !!record.audioUrl).map(record => [record.recordId, record])).values()]
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.recordId.localeCompare(a.recordId));
}

export function nextSelection(records: DemoRecordSummary[], selectedId: string | null, delta: number) {
  if (!records.length) return null;
  const index = records.findIndex(record => record.recordId === selectedId);
  return records[Math.max(0, Math.min(records.length - 1, index < 0 ? 0 : index + delta))].recordId;
}

export function nextLoopSelection(records: DemoRecordSummary[], selectedId: string | null) {
  if (!records.length) return null;
  const index = records.findIndex(record => record.recordId === selectedId);
  return records[(index < 0 ? 0 : index + 1) % records.length].recordId;
}

export function preserveSelection(previous: DemoRecordSummary[], next: DemoRecordSummary[], selectedId: string | null) {
  if (next.some(record => record.recordId === selectedId)) return selectedId;
  const oldIndex = Math.max(0, previous.findIndex(record => record.recordId === selectedId));
  return next[Math.min(oldIndex, next.length - 1)]?.recordId ?? null;
}

export function cardTraits(id: string) {
  let seed = 2166136261;
  for (const char of id) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  return { x: (random() * 2 - 1) * 20, y: (random() * 2 - 1) * 25,
    rotation: (random() * 2 - 1) * .8, duration: 6 + random() * 5,
    delay: -random() * 11, amplitude: 6 + random() * 6, shadow: .85 + random() * .25 };
}

export function galleryLayout(width: number, height: number) {
  const columns = width >= 960 ? 4 : width >= 520 ? 2 : 1;
  const scale = Math.max(.42, Math.min(width / 1920, height / 1080));
  const padding = Math.max(18, 48 * scale);
  const cellWidth = (width - padding * 2) / columns;
  const topPadding = columns === 4 ? 0 : padding;
  const rowHeight = columns === 4 ? Math.max(210, height / 2) : Math.max(280, Math.min(490, cellWidth * 1.4));
  const cardWidth = Math.max(130, Math.min(cellWidth - 72 * scale, (rowHeight - 94 * scale) / 1.18));
  const cardHeight = cardWidth * 1.18;
  return { width, height, columns, scale, padding, topPadding, cellWidth, rowHeight, cardWidth, cardHeight };
}
export type GalleryLayout = ReturnType<typeof galleryLayout>;

export function cardPosition(index: number, id: string, layout: GalleryLayout) {
  const traits = cardTraits(id);
  return {
    left: layout.padding + (index % layout.columns) * layout.cellWidth + (layout.cellWidth - layout.cardWidth) / 2 + traits.x * layout.scale,
    top: layout.topPadding + Math.floor(index / layout.columns) * layout.rowHeight + (layout.rowHeight - layout.cardHeight) / 2 + traits.y * layout.scale,
  };
}

export function contentHeight(count: number, layout: GalleryLayout) {
  return Math.max(layout.height, layout.topPadding * 2 + Math.ceil(count / layout.columns) * layout.rowHeight);
}

// Reveal the whole row, not each card's random vertical offset. Moving between
// neighboring works in the same row must not nudge the viewport up and down.
export function selectionScrollTarget(index: number, count: number, layout: GalleryLayout, scrollTop: number) {
  const rowTop = layout.topPadding + Math.floor(index / layout.columns) * layout.rowHeight;
  let target = scrollTop;
  if (rowTop < scrollTop) target = rowTop;
  else if (rowTop + layout.rowHeight > scrollTop + layout.height)
    target = layout.rowHeight > layout.height ? rowTop : rowTop + layout.rowHeight - layout.height;
  return Math.max(0, Math.min(contentHeight(count, layout) - layout.height, target));
}

export type SelectionScroll = { from: number; to: number; startedAt: number };

export function selectionScrollFrame(scroll: SelectionScroll, now: number) {
  const progress = Math.max(0, Math.min(1, (now - scroll.startedAt) / GALLERY_SETTINGS.selectionScrollMs));
  // Move promptly on input, then decelerate into the row without a hard cut.
  const eased = 1 - (1 - progress) * (1 - progress);
  return { top: scroll.from + (scroll.to - scroll.from) * eased, done: progress === 1 };
}

export function tourEnd(count: number, layout: GalleryLayout) {
  return Math.max(0, contentHeight(Math.min(count, GALLERY_SETTINGS.tourLimit), layout) - layout.height);
}

// One continuous path. Each row joins the next; the visible segment can be
// generated independently, keeping a 700-work wall as light as a small one.
export function pencilPath(firstRow: number, lastRow: number, layout: GalleryLayout) {
  const { width: w, rowHeight: h, padding } = layout;
  let d = `M ${w * .04} ${padding + firstRow * h}`;
  for (let row = firstRow; row <= lastRow; row++) {
    const y = padding + row * h;
    d += ` C ${w * .28} ${y + h * .1}, ${w * .3} ${y + h * .8}, ${w * .52} ${y + h * .6}`
      + ` C ${w * .75} ${y + h * .37}, ${w * .37} ${y - h * .1}, ${w * .48} ${y + h * .15}`
      + ` C ${w * .62} ${y + h * .49}, ${w * .83} ${y + h * .22}, ${w * .97} ${y + h * .65}`
      + ` C ${w * 1.08} ${y + h * .98}, ${w * .13} ${y + h * .68}, ${w * .04} ${y + h}`;
  }
  return d;
}

export function readGalleryVolume() {
  try {
    const saved = localStorage.getItem("ekaki-gallery-volume");
    const volume = saved === null ? 1 : Number(saved);
    return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
  } catch { return 1; }
}
