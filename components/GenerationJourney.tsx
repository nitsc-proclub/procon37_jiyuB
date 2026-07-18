import React, { useEffect, useMemo, useRef, useState } from "react";
import { DrawingData, Point } from "../types";

type GenerationJourneyProps = {
  stageLabel: string;
  drawingData?: DrawingData | null;
  compact?: boolean;
};

const JOURNEY_STEPS = [
  "絵をじっくり見ているよ",
  "歌声に魔法をかけているよ",
];

const getSourceSize = (drawingData: DrawingData) => {
  if (drawingData.canvasSize?.width && drawingData.canvasSize.height) {
    return drawingData.canvasSize;
  }

  const points = drawingData.strokes.flatMap((stroke) => stroke.points);
  return {
    width: Math.max(1, ...points.map((point) => point.x)),
    height: Math.max(1, ...points.map((point) => point.y)),
  };
};

const TransformationCanvas: React.FC<{ drawingData: DrawingData }> = ({ drawingData }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1, dpr: 1 });
  const sourceSize = useMemo(() => getSourceSize(drawingData), [drawingData]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateSize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      setCanvasSize({ width, height, dpr });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const scalePoint = (point: Point) => ({
      x: point.x * (canvasSize.width / sourceSize.width),
      y: point.y * (canvasSize.height / sourceSize.height),
    });
    const prepare = () => {
      context.setTransform(canvasSize.dpr, 0, 0, canvasSize.dpr, 0, 0);
      context.clearRect(0, 0, canvasSize.width, canvasSize.height);
      context.fillStyle = "#fffdf7";
      context.fillRect(0, 0, canvasSize.width, canvasSize.height);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = (drawingData.lineWidth ?? 4) * Math.min(canvasSize.width / sourceSize.width, canvasSize.height / sourceSize.height);
      context.strokeStyle = "#26324d";
      context.fillStyle = "#26324d";
    };
    const draw = (progress: number) => {
      prepare();
      const count = drawingData.strokes.length;
      const scaledProgress = progress * count;
      drawingData.strokes.forEach((stroke, strokeIndex) => {
        const strokeProgress = Math.max(0, Math.min(1, scaledProgress - strokeIndex));
        if (strokeProgress <= 0 || stroke.points.length === 0) return;
        if (stroke.points.length === 1) {
          const point = scalePoint(stroke.points[0]);
          context.beginPath();
          context.arc(point.x, point.y, context.lineWidth / 2, 0, Math.PI * 2);
          context.fill();
          return;
        }
        const visiblePointCount = Math.max(2, Math.ceil(stroke.points.length * strokeProgress));
        const points = stroke.points.slice(0, visiblePointCount).map(scalePoint);
        context.beginPath();
        context.moveTo(points[0].x, points[0].y);
        points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
        context.stroke();
      });
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      draw(1);
      return;
    }

    let frameId = 0;
    const startedAt = performance.now();
    const drawDuration = Math.min(7000, Math.max(2800, drawingData.strokes.length * 240));
    const completedHoldDuration = 650;
    const drawFrame = (now: number) => {
      const cycleElapsed = (now - startedAt) % (drawDuration + completedHoldDuration);
      draw(cycleElapsed >= drawDuration ? 1 : cycleElapsed / drawDuration);
      frameId = window.requestAnimationFrame(drawFrame);
    };
    frameId = window.requestAnimationFrame(drawFrame);
    return () => window.cancelAnimationFrame(frameId);
  }, [canvasSize, drawingData, sourceSize]);

  return <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />;
};

const GenerationJourney: React.FC<GenerationJourneyProps> = ({ stageLabel, drawingData, compact = false }) => (
  <div className={`generation-journey flex h-full flex-col items-center justify-center text-center ${compact ? "min-h-0" : "min-h-[340px]"}`}>
    {compact && <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{stageLabel}</p>}
    {drawingData && compact ? (
      <div className={`relative w-full overflow-hidden bg-[#fffdf7] ${compact ? "h-full" : "aspect-square max-w-[21rem] rounded-3xl border-4 border-yellow-200 shadow-lg"}`}>
        <TransformationCanvas drawingData={drawingData} />
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center bg-gradient-to-b from-white/95 via-white/75 to-transparent px-3 pb-8 pt-3">
          <p className="rounded-full border-2 border-orange-200 bg-white/95 px-4 py-2 text-sm font-black text-orange-800 shadow-sm sm:text-base">
            <span aria-hidden="true">✦ </span>{stageLabel}
          </p>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-white via-white/95 to-transparent px-3 pb-3 pt-10">
          <p className="text-sm font-bold text-slate-600">どんな歌にしようか考えているよ</p>
        </div>
      </div>
    ) : (
      <>
        <div className="mb-5 text-6xl" aria-hidden="true">🎨</div>
        <p className="text-2xl font-black text-orange-800">{stageLabel}</p>
      </>
    )}

    {!compact && (
      <>
        <p className="mt-5 text-sm font-bold text-slate-500">AIとずんだもんが、順番に歌をつくっています</p>
        <div className="mt-4 grid w-full max-w-xl gap-2 sm:grid-cols-2">
          {JOURNEY_STEPS.map((step) => (
            <div key={step} className={`rounded-2xl border px-3 py-2 text-sm font-bold ${step === stageLabel ? "border-orange-400 bg-orange-50 text-orange-900 shadow-sm" : "border-orange-100 bg-white/70 text-slate-500"}`}>
              {step === stageLabel ? "✦ " : "○ "}{step}
            </div>
          ))}
        </div>
      </>
    )}
  </div>
);

export default GenerationJourney;
