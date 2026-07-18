import React, { useEffect, useRef, useState } from "react";
import DrawingPlaybackCanvas, { DrawingDisplayMode } from "./DrawingPlaybackCanvas";
import GenerationJourney from "./GenerationJourney";
import { DrawingData, LyricStrokeMapping, Point, SingingScore, Stroke } from "../types";

export type DrawingMetrics = {
  strokeCount: number;
  pointCount: number;
  drawingDurationMs: number;
};

interface PaintCanvasProps {
  onComplete: (data: DrawingData) => void;
  onClear: () => void;
  onEditStart?: () => void;
  onDrawingMetricsChange?: (metrics: DrawingMetrics) => void;
  guideState?: "draw" | "generate" | null;
  isGenerating: boolean;
  isInteractionBlocked?: boolean;
  generationStageLabel?: string;
  generationDisabled?: boolean;
  generationDisabledMessage?: string;
  initialDrawing?: DrawingData | null;
  playbackDrawing?: DrawingData | null;
  playbackAudioRef?: React.RefObject<HTMLAudioElement | null>;
  playbackDisplayMode?: DrawingDisplayMode;
  playbackAnimationEndProgress?: number;
  playbackLineStrokeMappings?: LyricStrokeMapping[];
  playbackScore?: SingingScore | null;
  playbackLyricLineCount?: number;
  isPlaybackActive?: boolean;
}

const LOGICAL_CANVAS_SIZE = 1024;
const DISPLAY_LINE_WIDTH = 4;

const isEditableKeyboardTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
};

const scaleStrokes = (strokes: Stroke[], sourceWidth: number, sourceHeight: number): Stroke[] => {
  const scaleX = LOGICAL_CANVAS_SIZE / Math.max(1, sourceWidth);
  const scaleY = LOGICAL_CANVAS_SIZE / Math.max(1, sourceHeight);

  return strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({
      ...point,
      x: point.x * scaleX,
      y: point.y * scaleY,
    })),
  }));
};

const inferLegacySourceSize = (strokes: Stroke[]) => {
  const points = strokes.flatMap((stroke) => stroke.points);
  const extent = Math.max(1, ...points.flatMap((point) => [point.x, point.y]));
  return { width: extent, height: extent };
};

const PaintCanvas: React.FC<PaintCanvasProps> = ({
  onComplete,
  onClear,
  onEditStart,
  onDrawingMetricsChange,
  guideState = null,
  isGenerating,
  isInteractionBlocked = false,
  generationStageLabel = "絵をじっくり見ているよ",
  generationDisabled = false,
  generationDisabledMessage = "現在、この機能は利用できません",
  initialDrawing,
  playbackDrawing,
  playbackAudioRef,
  playbackDisplayMode = "animated",
  playbackAnimationEndProgress = 1,
  playbackLineStrokeMappings,
  playbackScore,
  playbackLyricLineCount,
  isPlaybackActive = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const focusSurfaceRef = useRef<HTMLDivElement>(null);
  const focusTriggerRef = useRef<HTMLButtonElement>(null);
  const focusExitRef = useRef<HTMLButtonElement>(null);
  const clearDialogRef = useRef<HTMLDivElement>(null);
  const clearConfirmButtonRef = useRef<HTMLButtonElement>(null);
  const clearTriggerButtonRef = useRef<HTMLButtonElement>(null);
  const wasClearConfirmOpenRef = useRef(false);
  const generationButtonRef = useRef<HTMLButtonElement>(null);
  const wasInteractionBlockedRef = useRef(false);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Point[]>([]);
  const activePointerIdRef = useRef<number | null>(null);
  const lineWidthRef = useRef(6);
  const focusModeRef = useRef(false);
  const wasFocusedRef = useRef(false);
  const imageLoadIdRef = useRef(0);
  const baseImageRef = useRef<HTMLImageElement | null>(null);
  const shouldUseBaseImageRef = useRef(false);

  const [isDrawing, setIsDrawing] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [undoneStrokes, setUndoneStrokes] = useState<Stroke[]>([]);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const isCanvasLocked = isGenerating || isPlaybackActive || isInteractionBlocked;

  const prepareContext = (context: CanvasRenderingContext2D) => {
    const displayWidth = Math.max(1, canvasRef.current?.getBoundingClientRect().width ?? LOGICAL_CANVAS_SIZE);
    lineWidthRef.current = (DISPLAY_LINE_WIDTH * LOGICAL_CANVAS_SIZE) / displayWidth;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = lineWidthRef.current;
    context.strokeStyle = "#26324d";
    context.fillStyle = "#26324d";
  };

  const redrawStrokes = (nextStrokes: Stroke[]) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    if (canvas.width !== LOGICAL_CANVAS_SIZE || canvas.height !== LOGICAL_CANVAS_SIZE) {
      canvas.width = LOGICAL_CANVAS_SIZE;
      canvas.height = LOGICAL_CANVAS_SIZE;
    }

    prepareContext(context);
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);

    if (nextStrokes.length === 0 && shouldUseBaseImageRef.current && baseImageRef.current) {
      context.drawImage(baseImageRef.current, 0, 0, canvas.width, canvas.height);
      prepareContext(context);
      return;
    }

    nextStrokes.forEach((stroke) => {
      if (stroke.points.length === 0) return;
      context.beginPath();
      if (stroke.points.length === 1) {
        const point = stroke.points[0];
        context.arc(point.x, point.y, context.lineWidth / 2, 0, Math.PI * 2);
        context.fill();
        return;
      }
      context.moveTo(stroke.points[0].x, stroke.points[0].y);
      stroke.points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
      context.stroke();
    });
  };

  const commitStrokes = (nextStrokes: Stroke[]) => {
    strokesRef.current = nextStrokes;
    setStrokes(nextStrokes);
    redrawStrokes(nextStrokes);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvasContainerRef.current;
    if (!canvas || !container) return;

    canvas.width = LOGICAL_CANVAS_SIZE;
    canvas.height = LOGICAL_CANVAS_SIZE;
    redrawStrokes(strokesRef.current);

    const observer = new ResizeObserver(() => redrawStrokes(strokesRef.current));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const loadId = ++imageLoadIdRef.current;
    if (!initialDrawing) {
      baseImageRef.current = null;
      shouldUseBaseImageRef.current = false;
      commitStrokes([]);
      setUndoneStrokes([]);
      return;
    }

    const image = new Image();
    image.onload = () => {
      if (loadId !== imageLoadIdRef.current) return;
      const sourceSize = initialDrawing.canvasSize ?? {
        width: Math.max(1, image.naturalWidth),
        height: Math.max(1, image.naturalHeight),
      };
      const normalized = scaleStrokes(initialDrawing.strokes ?? [], sourceSize.width, sourceSize.height);
      baseImageRef.current = image;
      shouldUseBaseImageRef.current = normalized.length === 0;
      commitStrokes(normalized);
      setUndoneStrokes([]);
      setIsClearConfirmOpen(false);
    };
    image.onerror = () => {
      if (loadId !== imageLoadIdRef.current) return;
      const inferred = initialDrawing.canvasSize ?? inferLegacySourceSize(initialDrawing.strokes ?? []);
      baseImageRef.current = null;
      shouldUseBaseImageRef.current = false;
      commitStrokes(scaleStrokes(initialDrawing.strokes ?? [], inferred.width, inferred.height));
      setUndoneStrokes([]);
    };
    image.src = initialDrawing.imageUri;

    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [initialDrawing]);

  useEffect(() => {
    onDrawingMetricsChange?.({
      strokeCount: strokes.length,
      pointCount: strokes.reduce((total, stroke) => total + stroke.points.length, 0),
      drawingDurationMs: strokes.reduce((total, stroke) => total + Math.max(0, stroke.endTime - stroke.startTime), 0),
    });
  }, [onDrawingMetricsChange, strokes]);

  useEffect(() => {
    focusModeRef.current = isFocusMode;
    if (isFocusMode) {
      wasFocusedRef.current = true;
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      document.body.dataset.drawingFocusMode = "true";
      window.requestAnimationFrame(() => focusExitRef.current?.focus());
      return () => {
        document.body.style.overflow = previousOverflow;
        delete document.body.dataset.drawingFocusMode;
      };
    }

    delete document.body.dataset.drawingFocusMode;
    if (wasFocusedRef.current) {
      wasFocusedRef.current = false;
      window.requestAnimationFrame(() => focusTriggerRef.current?.focus());
    }
  }, [isFocusMode]);

  useEffect(() => {
    if (isClearConfirmOpen) {
      wasClearConfirmOpenRef.current = true;
      window.requestAnimationFrame(() => clearConfirmButtonRef.current?.focus());
    } else if (wasClearConfirmOpenRef.current) {
      wasClearConfirmOpenRef.current = false;
      window.requestAnimationFrame(() => clearTriggerButtonRef.current?.focus());
    }
  }, [isClearConfirmOpen]);

  const exitFocusMode = () => {
    focusModeRef.current = false;
    setIsFocusMode(false);
    if (document.fullscreenElement && document.exitFullscreen) {
      void document.exitFullscreen().catch(() => undefined);
    }
  };

  const enterFocusMode = () => {
    if (isCanvasLocked) return;
    focusModeRef.current = true;
    setIsFocusMode(true);
    const surface = focusSurfaceRef.current;
    if (surface?.requestFullscreen) {
      void surface.requestFullscreen().catch(() => undefined);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (focusModeRef.current && !document.fullscreenElement) {
        focusModeRef.current = false;
        setIsFocusMode(false);
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const getCoordinates = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * LOGICAL_CANVAS_SIZE,
      y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * LOGICAL_CANVAS_SIZE,
      timestamp: Date.now(),
    };
  };

  const startDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (isCanvasLocked || event.button !== 0 || activePointerIdRef.current !== null) return;
    onEditStart?.();
    event.preventDefault();
    shouldUseBaseImageRef.current = false;
    activePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    currentStrokeRef.current = [getCoordinates(event)];
    setUndoneStrokes([]);
    setIsDrawing(true);
  };

  const draw = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || isCanvasLocked || activePointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    const point = getCoordinates(event);
    const previous = currentStrokeRef.current.at(-1);
    const context = canvasRef.current?.getContext("2d");
    if (!previous || !context) return;
    prepareContext(context);
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    currentStrokeRef.current.push(point);
  };

  const finishDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    activePointerIdRef.current = null;
    setIsDrawing(false);
    const points = currentStrokeRef.current;
    currentStrokeRef.current = [];
    if (isCanvasLocked || points.length === 0) {
      redrawStrokes(strokesRef.current);
      return;
    }
    const nextStroke: Stroke = {
      points: [...points],
      startTime: points[0].timestamp,
      endTime: points.at(-1)?.timestamp ?? points[0].timestamp,
    };
    commitStrokes([...strokesRef.current, nextStroke]);
  };

  const cancelDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    activePointerIdRef.current = null;
    currentStrokeRef.current = [];
    setIsDrawing(false);
    redrawStrokes(strokesRef.current);
  };

  const clearCanvas = () => {
    shouldUseBaseImageRef.current = false;
    baseImageRef.current = null;
    commitStrokes([]);
    setUndoneStrokes([]);
    setIsClearConfirmOpen(false);
    onClear();
  };

  const handleClear = () => {
    if (!isGenerating && !isInteractionBlocked) setIsClearConfirmOpen(true);
  };

  const handleUndo = () => {
    if (isCanvasLocked || strokesRef.current.length === 0) return;
    onEditStart?.();
    shouldUseBaseImageRef.current = false;
    const undone = strokesRef.current.at(-1)!;
    commitStrokes(strokesRef.current.slice(0, -1));
    setUndoneStrokes((current) => [undone, ...current]);
  };

  const handleRedo = () => {
    if (isCanvasLocked || undoneStrokes.length === 0) return;
    onEditStart?.();
    shouldUseBaseImageRef.current = false;
    commitStrokes([...strokesRef.current, undoneStrokes[0]]);
    setUndoneStrokes((current) => current.slice(1));
  };

  const handleGenerate = () => {
    if (strokesRef.current.length === 0 || isCanvasLocked || generationDisabled || isFocusMode) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    onComplete({
      strokes: strokesRef.current,
      imageUri: canvas.toDataURL("image/png"),
      canvasSize: { width: LOGICAL_CANVAS_SIZE, height: LOGICAL_CANVAS_SIZE },
      lineWidth: lineWidthRef.current,
    });
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableKeyboardTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (isClearConfirmOpen) {
        if (key === "tab") {
          const focusable = Array.from(
            clearDialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
          ) as HTMLButtonElement[];
          if (focusable.length > 0) {
            const currentIndex = focusable.indexOf(document.activeElement as HTMLButtonElement);
            const nextIndex = event.shiftKey
              ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
              : (currentIndex + 1) % focusable.length;
            event.preventDefault();
            focusable[nextIndex].focus();
          }
        } else if (key === "escape") {
          event.preventDefault();
          setIsClearConfirmOpen(false);
        } else if (key === "enter") {
          event.preventDefault();
          clearCanvas();
        }
        return;
      }
      if (isFocusMode && key === "tab") {
        const focusable = Array.from(
          focusSurfaceRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
        ) as HTMLButtonElement[];
        if (focusable.length > 0) {
          const currentIndex = focusable.indexOf(document.activeElement as HTMLButtonElement);
          const nextIndex = event.shiftKey
            ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
            : (currentIndex + 1) % focusable.length;
          event.preventDefault();
          focusable[nextIndex].focus();
        }
        return;
      }
      if (isFocusMode && key === "escape") {
        event.preventDefault();
        exitFocusMode();
        return;
      }
      if (key === "enter") {
        event.preventDefault();
        handleGenerate();
        return;
      }
      if (key === "s" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        handleGenerate();
        return;
      }
      if (!event.ctrlKey && !event.metaKey && (key === "delete" || key === "backspace")) {
        event.preventDefault();
        handleClear();
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        handleUndo();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [generationDisabled, isCanvasLocked, isClearConfirmOpen, isFocusMode, isGenerating, onEditStart, undoneStrokes]);

  useEffect(() => {
    if (!isPlaybackActive) return;
    activePointerIdRef.current = null;
    currentStrokeRef.current = [];
    setIsDrawing(false);
    setIsClearConfirmOpen(false);
    redrawStrokes(strokesRef.current);
  }, [isPlaybackActive]);

  useEffect(() => {
    if (!isGenerating || !canvasContainerRef.current || !window.matchMedia("(max-width: 1023px)").matches) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      canvasContainerRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [isGenerating]);

  useEffect(() => {
    if (wasInteractionBlockedRef.current && !isInteractionBlocked && !isGenerating) {
      generationButtonRef.current?.focus();
    }
    wasInteractionBlockedRef.current = isInteractionBlocked;
  }, [isGenerating, isInteractionBlocked]);

  const undoButton = (
    <button type="button" onClick={handleUndo} disabled={strokes.length === 0 || isCanvasLocked} className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border-2 border-slate-200 bg-white text-slate-700 shadow-md transition-all hover:bg-slate-50 disabled:opacity-40 active:scale-95 focus-visible:outline focus-visible:outline-4 focus-visible:outline-violet-400" title="戻す" aria-label="ひとつ戻す">
      <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 7 4 12l5 5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M5 12h9.5a4.5 4.5 0 0 1 0 9H12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
    </button>
  );
  const redoButton = (
    <button type="button" onClick={handleRedo} disabled={undoneStrokes.length === 0 || isCanvasLocked} className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border-2 border-slate-200 bg-white text-slate-700 shadow-md transition-all hover:bg-slate-50 disabled:opacity-40 active:scale-95 focus-visible:outline focus-visible:outline-4 focus-visible:outline-violet-400" title="進める" aria-label="ひとつ進める">
      <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m15 7 5 5-5 5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M19 12H9.5a4.5 4.5 0 0 0 0 9H12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
    </button>
  );

  return (
    <>
      <div
        ref={focusSurfaceRef}
        className={isFocusMode ? "fixed inset-0 z-[100] flex min-h-0 w-full flex-col items-center overflow-auto bg-gradient-to-b from-yellow-50 via-orange-50 to-white px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]" : "relative flex w-full max-w-full flex-col items-center gap-4"}
        role={isFocusMode ? "dialog" : undefined}
        aria-modal={isFocusMode ? true : undefined}
        aria-label={isFocusMode ? "大きく描くモード" : undefined}
      >
        {isFocusMode && (
          <div className="mb-2 flex w-full max-w-5xl items-center justify-center text-slate-800">
            <p className="text-sm font-black sm:text-lg">✦ 大きなキャンバスで描こう</p>
          </div>
        )}

        {!isFocusMode && guideState === "draw" && (
          <div className="pointer-events-none absolute inset-x-0 top-4 z-30 mx-auto w-fit max-w-[calc(100%_-_2rem)] rounded-2xl bg-white/90 px-5 py-3 text-center text-xl font-black text-violet-800 shadow-lg backdrop-blur-sm sm:text-2xl" role="status" aria-live="polite">
            <span aria-hidden="true">✨</span> ここに好きな絵をかいてみよう！
            <div className="mt-1 text-xl leading-none text-violet-500" aria-hidden="true">↓</div>
          </div>
        )}

        <div
          ref={canvasContainerRef}
          onContextMenu={(event) => event.preventDefault()}
          className={`paint-canvas-frame relative aspect-square select-none overflow-hidden bg-white shadow-2xl ${isFocusMode ? "rounded-2xl border-4 border-yellow-300" : "w-full max-w-[42rem] rounded-3xl border-8 border-yellow-200"}`}
          style={isFocusMode ? { width: "min(calc(100vw - 1.5rem), calc(100dvh - 8.75rem))", maxWidth: "64rem" } : undefined}
        >
          <canvas
            ref={canvasRef}
            onPointerDown={startDrawing}
            onPointerMove={draw}
            onPointerUp={finishDrawing}
            onPointerCancel={cancelDrawing}
            onContextMenu={(event) => event.preventDefault()}
            className="h-full w-full touch-none cursor-crosshair"
            aria-label="好きな絵を描くキャンバス"
            role="img"
          />
          {isPlaybackActive && playbackDrawing && playbackAudioRef && (
            <div className="absolute inset-0 z-10 bg-white"><DrawingPlaybackCanvas drawingData={playbackDrawing} audioRef={playbackAudioRef} mode={playbackDisplayMode} animationEndProgress={playbackAnimationEndProgress} lineStrokeMappings={playbackLineStrokeMappings} singingScore={playbackScore} lyricLineCount={playbackLyricLineCount}/></div>
          )}
          {isGenerating && (
            <div className="absolute inset-0 z-20 bg-white">
              <GenerationJourney stageLabel={generationStageLabel} drawingData={playbackDrawing ?? initialDrawing} compact />
            </div>
          )}
        </div>

        {isFocusMode ? (
          <div className="mt-3 grid w-full max-w-xl grid-cols-4 gap-2">
            <button ref={clearTriggerButtonRef} type="button" onClick={handleClear} disabled={isGenerating || isInteractionBlocked} className="flex h-14 min-w-0 items-center justify-center rounded-2xl bg-slate-200 px-1 text-sm font-black text-slate-800 shadow-md disabled:opacity-50 sm:px-3 sm:text-base">ぜんぶ消す</button>
            <button type="button" onClick={handleUndo} disabled={strokes.length === 0 || isCanvasLocked} className="flex h-14 min-w-0 items-center justify-center rounded-2xl border-2 border-slate-200 bg-white text-slate-700 shadow-md transition hover:bg-slate-50 disabled:opacity-40 active:scale-95 focus-visible:outline focus-visible:outline-4 focus-visible:outline-violet-400" title="戻す" aria-label="ひとつ戻す">
              <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 7 4 12l5 5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M5 12h9.5a4.5 4.5 0 0 1 0 9H12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button type="button" onClick={handleRedo} disabled={undoneStrokes.length === 0 || isCanvasLocked} className="flex h-14 min-w-0 items-center justify-center rounded-2xl border-2 border-slate-200 bg-white text-slate-700 shadow-md transition hover:bg-slate-50 disabled:opacity-40 active:scale-95 focus-visible:outline focus-visible:outline-4 focus-visible:outline-violet-400" title="進める" aria-label="ひとつ進める">
              <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m15 7 5 5-5 5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M19 12H9.5a4.5 4.5 0 0 0 0 9H12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button ref={focusExitRef} type="button" onClick={exitFocusMode} className="flex h-14 min-w-0 items-center justify-center rounded-2xl bg-orange-500 px-1 text-sm font-black text-white shadow-md transition hover:bg-orange-600 active:scale-95 focus-visible:outline focus-visible:outline-4 focus-visible:outline-yellow-300 sm:px-3 sm:text-base">できた！</button>
          </div>
        ) : (
          <>
            <div className="flex w-full justify-end">
              <button ref={focusTriggerRef} type="button" onClick={enterFocusMode} disabled={isCanvasLocked} aria-pressed={isFocusMode} className="focus-button flex min-h-12 items-center gap-2 rounded-2xl bg-violet-600 px-5 py-3 text-base font-black text-white shadow-lg transition-all hover:bg-violet-700 disabled:opacity-50 active:scale-95 focus-visible:outline focus-visible:outline-4 focus-visible:outline-violet-300">
                <span aria-hidden="true">⛶</span> 大きく描く
              </button>
            </div>
            {guideState === "generate" && (
              <div className="w-full px-4 py-1 text-center font-black text-amber-800" role="status" aria-live="polite">
                絵ができたね！ つぎは「歌をつくる！」を押してみよう <span aria-hidden="true">↓</span>
              </div>
            )}
            <div className="paint-toolbar flex w-full max-w-full flex-wrap gap-2 sm:gap-3">
              <button ref={clearTriggerButtonRef} type="button" onClick={handleClear} disabled={isGenerating || isInteractionBlocked} className="flex h-14 min-w-[7.25rem] flex-1 items-center justify-center whitespace-nowrap rounded-2xl bg-slate-200 px-3 text-base font-bold text-slate-700 shadow-md transition-all hover:bg-slate-300 disabled:opacity-50 active:scale-95">ぜんぶ消す</button>
              {undoButton}{redoButton}
              <button ref={generationButtonRef} type="button" onClick={handleGenerate} disabled={strokes.length === 0 || isCanvasLocked || generationDisabled} className="flex h-14 w-full min-w-[8rem] flex-1 items-center justify-center whitespace-nowrap rounded-2xl bg-yellow-400 px-3 text-base font-black text-slate-900 shadow-md transition-all hover:bg-yellow-500 disabled:bg-slate-300 disabled:text-slate-500 disabled:opacity-70 active:scale-95 sm:w-auto" title={generationDisabled ? generationDisabledMessage : "歌をつくる! (Ctrl+S / Cmd+S)"}>
                {generationDisabled ? "生成は準備中" : "歌をつくる！"}
              </button>
            </div>
            {generationDisabled && <p className="w-full text-center text-sm font-bold text-orange-700" role="status">{generationDisabledMessage}</p>}
          </>
        )}
      </div>

      {isClearConfirmOpen && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 px-4 backdrop-blur-sm" role="presentation" onClick={() => setIsClearConfirmOpen(false)}>
          <div ref={clearDialogRef} className="w-full max-w-sm rounded-3xl border-4 border-yellow-200 bg-white p-6 text-center shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="clear-confirm-title" onClick={(event) => event.stopPropagation()}>
            <p id="clear-confirm-title" className="mb-5 text-2xl font-black text-slate-800">ぜんぶ消しますか？</p>
            <div className="flex gap-3">
              <button ref={clearConfirmButtonRef} type="button" onClick={clearCanvas} className="flex h-14 flex-1 items-center justify-center rounded-2xl bg-orange-600 px-4 font-black text-white shadow-md">ぜんぶ消す</button>
              <button type="button" onClick={() => setIsClearConfirmOpen(false)} className="flex h-14 flex-1 items-center justify-center rounded-2xl bg-slate-200 px-4 font-black text-slate-700 shadow-md">キャンセル</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default PaintCanvas;
