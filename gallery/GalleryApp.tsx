import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import PrintLayout from "../components/PrintLayout";
import type { DemoRecordDetail, DemoRecordSummary } from "../types";
import GalleryCard from "./GalleryCard";
import GalleryPlayback from "./GalleryPlayback";
import { useGalleryRecords } from "./useGalleryRecords";
import {
  cardPosition, contentHeight, createNavigationInputFilter, galleryLayout, GALLERY_ACTION_EVENT, GALLERY_ACTIONS, GALLERY_SETTINGS,
  keyAction, nextSelection, pencilPath, preserveSelection, readGalleryVolume, tourEnd,
  nextLoopSelection, selectionScrollFrame, selectionScrollTarget, type GalleryAction, type SelectionScroll,
} from "./model";
import "./gallery.css";

type Anchor = { id: string; offset: number };
type Transition = { kind: "loop" | "arrival"; startedAt: number; moved: boolean };
const workFromUrl = () => new URLSearchParams(window.location.search).get("work");

export default function GalleryApp() {
  const viewport = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [records, setRecords] = useState<DemoRecordSummary[]>([]);
  const recordsRef = useRef(records);
  const [layout, setLayout] = useState(() => galleryLayout(window.innerWidth, window.innerHeight));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [scrollRow, setScrollRow] = useState(0);
  const [atTop, setAtTop] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [printRecord, setPrintRecord] = useState<DemoRecordDetail | null>(null);
  const selection = useRef(selectedId);
  const [workId, setWorkId] = useState(workFromUrl);
  const work = useRef(workId);
  const [idle, setIdle] = useState(false);
  const idleRef = useRef(false);
  const [fading, setFading] = useState(false);
  const transition = useRef<Transition | null>(null);
  const [introducedId, setIntroducedId] = useState<string | null>(null);
  const introduction = useRef<{ id: string; until: number } | null>(null);
  const pending = useRef<string[]>([]);
  const anchorToRestore = useRef<Anchor | null>(null);
  const returnAnchor = useRef<Anchor | null>(null);
  const lastInput = useRef(performance.now());
  const endSince = useRef<number | null>(null);
  const [volume, setVolume] = useState(readGalleryVolume);
  const volumeRef = useRef(volume);
  const [volumeNotice, setVolumeNotice] = useState(false);
  const volumeTimer = useRef<number | null>(null);
  const actionRef = useRef<(action: GalleryAction) => void>(() => { });
  const navigationInput = useRef(createNavigationInputFilter());
  const selectionScroll = useRef<SelectionScroll | null>(null);
  const resumeSelectionScroll = useRef(false);

  const select = useCallback((id: string | null) => { selection.current = id; setSelectedId(id); }, []);
  const captureAnchor = useCallback((): Anchor | null => {
    const element = viewport.current, items = recordsRef.current, geometry = layoutRef.current;
    if (!element || !items.length) return null;
    const row = Math.max(0, Math.floor((element.scrollTop - geometry.topPadding) / geometry.rowHeight));
    const index = Math.min(items.length - 1, row * geometry.columns);
    return { id: items[index].recordId, offset: cardPosition(index, items[index].recordId, geometry).top - element.scrollTop };
  }, []);
  const restoreAnchor = useCallback((anchor: Anchor | null) => {
    if (!anchor || !viewport.current) return;
    const index = recordsRef.current.findIndex(record => record.recordId === anchor.id);
    if (index >= 0) viewport.current.scrollTop = Math.max(0, cardPosition(index, anchor.id, layoutRef.current).top - anchor.offset);
  }, []);
  const revealSelection = useCallback((id: string | null) => {
    const element = viewport.current;
    const index = recordsRef.current.findIndex(record => record.recordId === id);
    if (!element || index < 0) return;
    const target = selectionScrollTarget(index, recordsRef.current.length, layoutRef.current, element.scrollTop);
    // Repeated navigation within a row should not restart a journey in progress.
    if (selectionScroll.current?.to === target) return;
    selectionScroll.current = Math.abs(target - element.scrollTop) < 1 ? null
      : { from: element.scrollTop, to: target, startedAt: performance.now() };
  }, []);
  const pauseSelectionScroll = useCallback(() => {
    if (selectionScroll.current) {
      resumeSelectionScroll.current = true;
      selectionScroll.current = null;
    }
  }, []);
  const activity = useCallback(() => {
    lastInput.current = performance.now();
    if (idleRef.current) {
      idleRef.current = false; setIdle(false);
      // Resume where the visitor is looking, not at a stale offscreen selection.
      const element = viewport.current, geometry = layoutRef.current;
      if (element) {
        const index = Math.max(0, Math.round((element.scrollTop - geometry.topPadding) / geometry.rowHeight)) * geometry.columns;
        select(recordsRef.current[Math.min(index, recordsRef.current.length - 1)]?.recordId ?? null);
      }
    }
    transition.current = null; setFading(false); endSince.current = null;
  }, [select]);

  const onSnapshot = useCallback((next: DemoRecordSummary[], initial: boolean) => {
    pauseSelectionScroll();
    const previous = recordsRef.current;
    const previousIds = new Set(previous.map(record => record.recordId));
    const nextIds = new Set(next.map(record => record.recordId));
    const added = initial ? [] : next.filter(record => !previousIds.has(record.recordId)).map(record => record.recordId);
    pending.current = [...new Set([...added, ...pending.current])].filter(id => nextIds.has(id)).slice(0, 8);
    // Keep the actual reading position fixed across insertions/deletions.
    // At the very top, the newly saved work should appear immediately instead.
    if (viewport.current && viewport.current.scrollTop > 8) anchorToRestore.current = captureAnchor();
    recordsRef.current = next;
    select(preserveSelection(previous, next, selection.current));
    setRecords(next);
  }, [captureAnchor, select, pauseSelectionScroll]);
  const { loading, error, skippedCount, refresh } = useGalleryRecords(onSnapshot);

  useLayoutEffect(() => {
    restoreAnchor(anchorToRestore.current);
    anchorToRestore.current = null;
    if (viewport.current) setScrollRow(Math.floor(viewport.current.scrollTop / layout.rowHeight));
    if (resumeSelectionScroll.current) {
      resumeSelectionScroll.current = false;
      revealSelection(selection.current);
    }
  }, [records, layout, restoreAnchor, revealSelection]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return;
      pauseSelectionScroll();
      anchorToRestore.current = captureAnchor();
      setLayout(galleryLayout(element.clientWidth, element.clientHeight));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [captureAnchor, pauseSelectionScroll]);

  const open = useCallback((id: string) => {
    activity(); select(id);
    // Enter may arrive before the scroll finishes. Keep the selected row in
    // view when returning from playback, without animating a hidden viewport.
    if (selectionScroll.current && viewport.current) viewport.current.scrollTop = selectionScroll.current.to;
    selectionScroll.current = null;
    resumeSelectionScroll.current = false;
    returnAnchor.current = captureAnchor();
    introduction.current = null; setIntroducedId(null);
    work.current = id; setWorkId(id);
    const url = new URL(window.location.href); url.searchParams.set("work", id);
    window.history.pushState({ gallery: true }, "", url);
  }, [activity, select, captureAnchor]);
  const back = useCallback(() => {
    selectionScroll.current = null;
    audioRef.current?.pause();
    work.current = null; setWorkId(null); activity();
    const url = new URL(window.location.href); url.searchParams.delete("work");
    window.history.replaceState({ gallery: true }, "", url);
    restoreAnchor(returnAnchor.current);
  }, [activity, restoreAnchor]);
  const advance = useCallback(() => {
    const nextId = nextLoopSelection(recordsRef.current, work.current);
    if (!nextId) { back(); return; }
    if (nextId === work.current) {
      const audio = audioRef.current;
      if (audio) { audio.currentTime = 0; void audio.play().catch(() => { }); }
      return;
    }
    open(nextId);
  }, [back, open]);
  useEffect(() => {
    const pop = () => {
      selectionScroll.current = null;
      const id = workFromUrl(); work.current = id; setWorkId(id); activity();
      if (!id) { audioRef.current?.pause(); restoreAnchor(returnAnchor.current); }
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [activity, restoreAnchor]);

  const updateVolume = useCallback((value: number) => {
    const next = Math.max(0, Math.min(1, value));
    volumeRef.current = next;
    setVolume(next);
    try { localStorage.setItem("ekaki-gallery-volume", String(next)); } catch { /* optional preference */ }
  }, []);

  const handlePrintRecord = useCallback((record: DemoRecordDetail) => {
    audioRef.current?.pause();
    setPrintRecord(record);
  }, []);

  actionRef.current = action => {
    activity();
    if (!navigationInput.current(action, performance.now())) return;
    if (action !== "next" && action !== "previous" && action !== "confirm") selectionScroll.current = null;
    if (action === "back") { if (work.current) back(); return; }
    if (action === "refresh") { refresh(); return; }
    if (action === "volumeUp" || action === "volumeDown") {
      const nextVolume = Math.max(0, Math.min(1, volumeRef.current + (action === "volumeUp" ? .05 : -.05)));
      if (audioRef.current) { audioRef.current.volume = nextVolume; audioRef.current.muted = false; }
      updateVolume(nextVolume);
      setVolumeNotice(true);
      if (volumeTimer.current !== null) window.clearTimeout(volumeTimer.current);
      volumeTimer.current = window.setTimeout(() => setVolumeNotice(false), 1400);
      return;
    }
    if (work.current) {
      if (action === "togglePlayback" || action === "confirm") {
        const audio = audioRef.current;
        if (audio?.paused) void audio.play().catch(() => { }); else audio?.pause();
      }
      return;
    }
    if (action === "confirm") { if (selection.current) open(selection.current); return; }
    if (action !== "next" && action !== "previous") return;
    const id = nextSelection(recordsRef.current, selection.current, action === "next" ? 1 : -1);
    select(id);
    revealSelection(id);
  };

  useEffect(() => {
    let pointer: { x: number; y: number } | null = null;
    const manualActivity = () => { selectionScroll.current = null; resumeSelectionScroll.current = false; activity(); };
    const pointerMove = (event: PointerEvent) => {
      if (!pointer) { pointer = { x: event.clientX, y: event.clientY }; return; }
      if (Math.abs(event.clientX - pointer.x) + Math.abs(event.clientY - pointer.y) < 3) return;
      pointer = { x: event.clientX, y: event.clientY }; manualActivity();
    };
    const key = (event: KeyboardEvent) => {
      activity();
      const target = event.target as HTMLElement | null;
      if (event.isComposing || target?.isContentEditable || target?.matches("input, textarea, select")) return;
      const action = keyAction(event);
      if (!action) selectionScroll.current = null;
      if (action) {
        event.preventDefault();
        // Holding Enter/Space must not alternate play/pause on every key repeat.
        if (!event.repeat || action === "next" || action === "previous") actionRef.current(action);
      }
    };
    const command = (event: Event) => {
      const action = (event as CustomEvent<unknown>).detail;
      if (typeof action === "string" && GALLERY_ACTIONS.includes(action as GalleryAction)) actionRef.current(action as GalleryAction);
    };
    const visibility = () => { selectionScroll.current = null; if (!document.hidden) activity(); };
    window.addEventListener("pointermove", pointerMove, { passive: true });
    window.addEventListener("pointerdown", manualActivity, { passive: true });
    window.addEventListener("wheel", manualActivity, { passive: true });
    window.addEventListener("touchstart", manualActivity, { passive: true });
    window.addEventListener("keydown", key);
    window.addEventListener(GALLERY_ACTION_EVENT, command);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pointermove", pointerMove); window.removeEventListener("pointerdown", manualActivity);
      window.removeEventListener("wheel", manualActivity); window.removeEventListener("touchstart", manualActivity);
      window.removeEventListener("keydown", key); window.removeEventListener(GALLERY_ACTION_EVENT, command);
      document.removeEventListener("visibilitychange", visibility);
      if (volumeTimer.current !== null) window.clearTimeout(volumeTimer.current);
    };
  }, [activity]);

  useEffect(() => {
    let frame = 0, previousTime = performance.now(), fractionalScroll = 0;
    const introduce = (now: number) => {
      // Only announce works still on the first screen; a burst cannot build an
      // endless animation backlog that prevents visitors using the exhibition.
      const firstPage = new Set(recordsRef.current.slice(0, layoutRef.current.columns * 2).map(record => record.recordId));
      pending.current = pending.current.filter(id => firstPage.has(id));
      const id = pending.current.shift();
      if (!id) return;
      introduction.current = { id, until: now + GALLERY_SETTINGS.introductionMs };
      setIntroducedId(id);
    };
    const tick = (now: number) => {
      const elapsed = Math.min(64, now - previousTime); previousTime = now;
      const element = viewport.current;
      if (!element || document.hidden || work.current || !recordsRef.current.length) { frame = requestAnimationFrame(tick); return; }
      if (selectionScroll.current) {
        const travel = selectionScrollFrame(selectionScroll.current, now);
        element.scrollTop = travel.top;
        if (travel.done) selectionScroll.current = null;
        frame = requestAnimationFrame(tick); return;
      }
      if (introduction.current) {
        if (now >= introduction.current.until) { introduction.current = null; setIntroducedId(null); }
        frame = requestAnimationFrame(tick); return;
      }
      const phase = transition.current;
      if (phase) {
        if (!phase.moved && now - phase.startedAt >= GALLERY_SETTINGS.fadeMs) {
          element.scrollTop = 0; phase.moved = true; setFading(false); endSince.current = null; fractionalScroll = 0;
        }
        if (now - phase.startedAt >= GALLERY_SETTINGS.fadeMs * 2) {
          transition.current = null;
          if (phase.kind === "arrival") introduce(now);
        }
        frame = requestAnimationFrame(tick); return;
      }
      if (!idleRef.current && now - lastInput.current >= GALLERY_SETTINGS.idleAfterMs) {
        idleRef.current = true; setIdle(true); endSince.current = null;
      }
      if (pending.current.length && (idleRef.current || (element.scrollTop < 8 && now - lastInput.current > 900))) {
        if (element.scrollTop > 8) {
          transition.current = { kind: "arrival", startedAt: now, moved: false }; setFading(true);
        } else introduce(now);
      } else if (idleRef.current) {
        const limit = tourEnd(recordsRef.current.length, layoutRef.current);
        if (element.scrollTop >= limit - 1) {
          if (limit > 0 || element.scrollTop > 0) {
            endSince.current ??= now;
            if (now - endSince.current >= GALLERY_SETTINGS.endPauseMs) {
              transition.current = { kind: "loop", startedAt: now, moved: false }; setFading(true);
            }
          }
        } else {
          endSince.current = null;
          fractionalScroll += elapsed / 1000 * layoutRef.current.height / GALLERY_SETTINGS.screenTravelSeconds;
          const pixels = Math.floor(fractionalScroll);
          if (pixels) { element.scrollTop = Math.min(limit, element.scrollTop + pixels); fractionalScroll -= pixels; }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const firstRow = Math.max(0, scrollRow - 1);
  const lastRow = Math.min(Math.ceil(records.length / layout.columns) - 1, scrollRow + 3);
  const firstIndex = firstRow * layout.columns;
  const visible = records.slice(firstIndex, (lastRow + 1) * layout.columns);
  const height = contentHeight(records.length, layout);

  return <>
    {printRecord && <PrintLayout lyrics={printRecord.lyrics} drawingData={printRecord.drawingData} onBack={() => setPrintRecord(null)} autoPrint showRomaji={false} />}
    <div className={printRecord ? "hidden" : undefined}>
      <div className={`gallery-app${idle ? " is-idle" : ""}`} data-mode={workId ? "playback" : idle ? "exhibition" : "browse"}>
        <div ref={viewport} className={`gallery-viewport${workId ? " is-covered" : ""}${atTop ? " at-top" : ""}`} aria-hidden={!!workId} inert={!!workId}
          onScroll={() => { if (viewport.current) { setScrollRow(Math.floor(viewport.current.scrollTop / layout.rowHeight)); setAtTop(viewport.current.scrollTop < 8); } }}>
          <main className="gallery-wall" aria-label="みんなの絵描き歌" style={{ height }}>
            {!!records.length && <svg className="gallery-pencil" aria-hidden="true" width={layout.width}
              style={{ top: firstRow * layout.rowHeight }} height={(lastRow - firstRow + 3) * layout.rowHeight}
              viewBox={`0 ${firstRow * layout.rowHeight} ${layout.width} ${(lastRow - firstRow + 3) * layout.rowHeight}`}>
              <defs><filter id="gallery-pencil-texture" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency=".07" numOctaves="2" seed="8" result="noise" /><feDisplacementMap in="SourceGraphic" in2="noise" scale="3" /></filter></defs>
              <path d={pencilPath(firstRow, lastRow + 1, layout)} filter="url(#gallery-pencil-texture)" />
            </svg>}
            {visible.map((record, offset) => <GalleryCard key={record.recordId} record={record} index={firstIndex + offset} layout={layout}
              selected={record.recordId === selectedId} introducing={record.recordId === introducedId}
              waiting={pending.current.includes(record.recordId) && record.recordId !== introducedId} idle={idle} onSelect={select} onOpen={open} />)}
            {!records.length && <div className="gallery-empty" role="status"><span aria-hidden="true">✎</span><p>{loading ? "みんなの作品を集めています…" : error ?? (skippedCount > 0 ? "読み込める作品がありませんでした。" : "最初の絵描き歌を待っています")}</p>{error && <button type="button" onClick={refresh}>もう一度読み込む</button>}</div>}
          </main>
        </div>
        <div className={`gallery-fade${fading ? " is-visible" : ""}`} aria-hidden="true" />
        {!!records.length && error && !workId && <div className="gallery-connection" role="status">接続を確認しています。保存済みの作品を表示しています。</div>}
        {!error && skippedCount > 0 && !workId && <div className="gallery-connection" role="status">{skippedCount}件の作品を読み込めませんでした。</div>}
        <GalleryPlayback recordId={workId} audioRef={audioRef} volume={volume} onVolume={updateVolume} onBack={back} onAdvance={advance} onPrint={handlePrintRecord} />
        {volumeNotice && <div className="gallery-volume" role="status">音量 {Math.round(volume * 100)}%</div>}
        <div className="gallery-sr-only" aria-live="polite">{introducedId ? `${records.find(record => record.recordId === introducedId)?.title ?? "新しい作品"}が仲間入りしました` : ""}</div>
      </div>
    </div>
  </>;
}
