
import React, { useRef, useEffect, useState } from 'react';
import DrawingPlaybackCanvas, { DrawingDisplayMode } from './DrawingPlaybackCanvas';
import { Point, Stroke, DrawingData, LyricStrokeMapping, SingingScore } from '../types';

interface PaintCanvasProps {
  onComplete: (data: DrawingData) => void;
  onClear: () => void;
  isGenerating: boolean;
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

const isEditableKeyboardTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
};

const PaintCanvas: React.FC<PaintCanvasProps> = ({
  onComplete,
  onClear,
  isGenerating,
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [undoneStrokes, setUndoneStrokes] = useState<Stroke[]>([]);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const currentStrokeRef = useRef<Point[]>([]);
  const lastPointRef = useRef<Point | null>(null);
  const isCanvasLocked = isGenerating || isPlaybackActive;

  const setupCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Use a temporary canvas to save current content if resizing
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    if (tempCtx) tempCtx.drawImage(canvas, 0, 0);

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#333';
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Restore content after resize
    ctx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, 0, 0, canvas.width, canvas.height);
  };

  const redrawStrokes = (nextStrokes: Stroke[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#333';
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    nextStrokes.forEach((stroke) => {
      if (stroke.points.length === 0) return;

      if (stroke.points.length === 1) {
        const point = stroke.points[0];
        ctx.beginPath();
        ctx.arc(point.x, point.y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fillStyle = '#333';
        ctx.fill();
        return;
      }

      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      stroke.points.slice(1).forEach((point) => {
        ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
    });
  };

  const drawImageUri = (imageUri: string, fallbackStrokes: Stroke[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const image = new Image();
    image.onload = () => {
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    };
    image.onerror = () => redrawStrokes(fallbackStrokes);
    image.src = imageUri;
  };

  const drawDot = (point: Point) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.beginPath();
    ctx.fillStyle = '#333';
    ctx.arc(point.x, point.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  };

  useEffect(() => {
    setupCanvas();
    window.addEventListener('resize', setupCanvas);
    return () => {
      window.removeEventListener('resize', setupCanvas);
    };
  }, []);

  useEffect(() => {
    if (!initialDrawing) return;

    const nextStrokes = initialDrawing.strokes ?? [];
    setStrokes(nextStrokes);
    setUndoneStrokes([]);
    setIsClearConfirmOpen(false);
    drawImageUri(initialDrawing.imageUri, nextStrokes);
  }, [initialDrawing]);

  const getCoordinates = (e: React.MouseEvent | React.TouchEvent): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;

    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
      timestamp: Date.now()
    };
  };

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    if (isCanvasLocked) return;
    if ('button' in e && e.button !== 0) return;
    e.preventDefault();
    const point = getCoordinates(e);
    setIsDrawing(true);
    setUndoneStrokes([]);
    currentStrokeRef.current = [point];
    lastPointRef.current = point;
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing || isCanvasLocked) return;
    e.preventDefault();
    const point = getCoordinates(e);
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    ctx.beginPath();
    ctx.moveTo(lastPointRef.current!.x, lastPointRef.current!.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();

    currentStrokeRef.current.push(point);
    lastPointRef.current = point;
  };

  const endDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);

    if (isCanvasLocked || currentStrokeRef.current.length === 0) {
      currentStrokeRef.current = [];
      lastPointRef.current = null;
      return;
    }

    const newStroke: Stroke = {
      points: [...currentStrokeRef.current],
      startTime: currentStrokeRef.current[0].timestamp,
      endTime: currentStrokeRef.current[currentStrokeRef.current.length - 1].timestamp
    };

    if (newStroke.points.length === 1) {
      drawDot(newStroke.points[0]);
    }

    setStrokes(prev => [...prev, newStroke]);
    currentStrokeRef.current = [];
    lastPointRef.current = null;
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setStrokes([]);
    setUndoneStrokes([]);
    setIsClearConfirmOpen(false);
    onClear();
  };

  const handleClear = () => {
    if (isCanvasLocked) return;
    setIsClearConfirmOpen(true);
  };

  const cancelClear = () => {
    setIsClearConfirmOpen(false);
  };

  const submitGenerate = () => {
    if (strokes.length === 0 || generationDisabled) return;
    const canvas = canvasRef.current!;
    const imageUri = canvas.toDataURL('image/png');
    onComplete({ strokes, imageUri });
  };

  const handleGenerate = () => {
    if (strokes.length === 0 || isCanvasLocked || generationDisabled) return;

    submitGenerate();
  };

  const handleUndo = () => {
    if (isCanvasLocked || strokes.length === 0) return;

    const nextStrokes = strokes.slice(0, -1);
    const undoneStroke = strokes[strokes.length - 1];
    setStrokes(nextStrokes);
    setUndoneStrokes((prev) => [undoneStroke, ...prev]);
    redrawStrokes(nextStrokes);
  };

  const handleRedo = () => {
    if (isCanvasLocked || undoneStrokes.length === 0) return;

    const redoneStroke = undoneStrokes[0];
    const nextStrokes = [...strokes, redoneStroke];
    setStrokes(nextStrokes);
    setUndoneStrokes((prev) => prev.slice(1));
    redrawStrokes(nextStrokes);
  };

  const preventCanvasContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableKeyboardTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();

      if (isClearConfirmOpen) {
        if (key === 'escape') {
          event.preventDefault();
          cancelClear();
          return;
        }

        if (key === 'enter') {
          event.preventDefault();
          clearCanvas();
        }

        return;
      }

      if (key === 'enter') {
        event.preventDefault();
        handleGenerate();
        return;
      }

      if (key === 's' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        handleGenerate();
        return;
      }

      if (!event.ctrlKey && !event.metaKey && (key === 'delete' || key === 'backspace')) {
        event.preventDefault();
        handleClear();
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) return;

      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        handleUndo();
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault();
        handleRedo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [strokes, undoneStrokes, isCanvasLocked, isClearConfirmOpen]);

  useEffect(() => {
    if (!isClearConfirmOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelClear();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isClearConfirmOpen]);

  useEffect(() => {
    if (!isPlaybackActive) return;

    setIsDrawing(false);
    currentStrokeRef.current = [];
    lastPointRef.current = null;
    setIsClearConfirmOpen(false);
  }, [isPlaybackActive]);

  return (
    <>
      <div className="relative flex w-full max-w-full flex-col items-center gap-6 transition-all duration-300">
        <div className="flex w-full flex-col items-center gap-4">
          <div
            ref={containerRef}
            onContextMenu={preventCanvasContextMenu}
            className="relative w-full max-w-[42rem] aspect-square select-none bg-white rounded-3xl shadow-xl overflow-hidden border-8 border-yellow-200"
          >
            <canvas
              ref={canvasRef}
              onMouseDown={startDrawing}
              onMouseMove={draw}
              onMouseUp={endDrawing}
              onMouseLeave={endDrawing}
              onContextMenu={preventCanvasContextMenu}
              onTouchStart={startDrawing}
              onTouchMove={draw}
              onTouchEnd={endDrawing}
              className="w-full h-full cursor-crosshair touch-none"
            />
            {isPlaybackActive && playbackDrawing && playbackAudioRef && (
              <div className="absolute inset-0 z-10 bg-white">
                <DrawingPlaybackCanvas
                  drawingData={playbackDrawing}
                  audioRef={playbackAudioRef}
                  mode={playbackDisplayMode}
                  animationEndProgress={playbackAnimationEndProgress}
                  lineStrokeMappings={playbackLineStrokeMappings}
                  singingScore={playbackScore}
                  lyricLineCount={playbackLyricLineCount}
                />
              </div>
            )}
            {isGenerating && (
              <div className="absolute inset-0 bg-white/80 flex flex-col items-center justify-center backdrop-blur-sm z-20">
                <div className="w-16 h-16 border-4 border-yellow-400 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-600 font-bold animate-pulse text-lg">AIが歌を考えています...</p>
              </div>
            )}
          </div>

          <div className="flex w-full max-w-full gap-2 sm:gap-3 md:col-start-2">
            <button
              onClick={handleClear}
              disabled={isCanvasLocked}
              className="flex h-14 min-w-[7.5rem] flex-[1.15] items-center justify-center whitespace-nowrap px-3 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-2xl font-bold transition-all disabled:opacity-50 text-base sm:text-lg shadow-md active:scale-95"
              title="ぜんぶ消す (Delete / Backspace)"
            >
              ぜんぶ消す
            </button>
            <button
              type="button"
              onClick={handleUndo}
              disabled={strokes.length === 0 || isCanvasLocked}
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white text-gray-700 shadow-md border-2 border-gray-200 transition-all hover:bg-gray-50 disabled:opacity-40 active:scale-95"
              title="戻す"
              aria-label="戻す"
            >
              <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M9 7 4 12l5 5"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M5 12h9.5a4.5 4.5 0 0 1 0 9H12"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={undoneStrokes.length === 0 || isCanvasLocked}
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white text-gray-700 shadow-md border-2 border-gray-200 transition-all hover:bg-gray-50 disabled:opacity-40 active:scale-95"
              title="進める"
              aria-label="進める"
            >
              <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="m15 7 5 5-5 5"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M19 12H9.5a4.5 4.5 0 0 0 0 9H12"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              onClick={handleGenerate}
              disabled={strokes.length === 0 || isCanvasLocked || generationDisabled}
              className="flex h-14 min-w-[8rem] flex-[1.15] items-center justify-center whitespace-nowrap px-3 bg-yellow-400 hover:bg-yellow-500 text-white rounded-2xl font-bold transition-all disabled:opacity-50 disabled:bg-gray-300 text-base sm:text-lg shadow-md active:scale-95"
              title={generationDisabled ? generationDisabledMessage : "歌をつくる! (Ctrl+S / Cmd+S)"}
            >
              {generationDisabled ? "生成は準備中" : "歌をつくる！"}
            </button>
          </div>
          {generationDisabled && (
            <p className="w-full text-center text-sm font-bold text-orange-600 md:col-start-2" role="status">
              {generationDisabledMessage}
            </p>
          )}
        </div>
      </div>

      {isClearConfirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-white/75 px-4 backdrop-blur-sm"
          role="presentation"
          onClick={cancelClear}
        >
          <div
            className="w-full max-w-sm rounded-3xl border-4 border-yellow-200 bg-white p-6 text-center shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <p id="clear-confirm-title" className="mb-5 text-2xl font-black text-gray-800">
              ぜんぶ消しますか？
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={clearCanvas}
                className="flex h-14 flex-1 items-center justify-center rounded-2xl bg-orange-500 px-4 text-base font-black text-white shadow-md transition-all hover:bg-orange-600 active:scale-95"
              >
                ぜんぶ消す
              </button>
              <button
                type="button"
                onClick={cancelClear}
                className="flex h-14 flex-1 items-center justify-center rounded-2xl bg-gray-200 px-4 text-base font-black text-gray-700 shadow-md transition-all hover:bg-gray-300 active:scale-95"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  );
};

export default PaintCanvas;
