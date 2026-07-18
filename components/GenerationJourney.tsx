import React, { useEffect, useMemo, useRef, useState } from "react";
import { DrawingData, GenerationTimingEstimate, GenerationTimingPhase, GENERATION_TIMING_PHASES, Point } from "../types";

type GenerationJourneyProps = {
  stageLabel: string;
  drawingData?: DrawingData | null;
  compact?: boolean;
  progressPhase?: GenerationTimingPhase;
  timingEstimate?: GenerationTimingEstimate | null;
  runKey?: number;
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

const GenerationProgressBar: React.FC<Pick<GenerationJourneyProps, "progressPhase" | "timingEstimate" | "runKey">> = ({ progressPhase = "gemini" as GenerationTimingPhase, timingEstimate, runKey = 0 }) => {
  const [value, setValue] = useState<number | null>(null);
  const valueRef = useRef(0);

  useEffect(() => {
    valueRef.current = 0;
    setValue(null);
  }, [runKey]);

  useEffect(() => {
    if (!timingEstimate?.determinate) {
      setValue(null);
      return;
    }
    const phaseIndex = GENERATION_TIMING_PHASES.indexOf(progressPhase);
    const rawDurations = GENERATION_TIMING_PHASES.map((phase) => Math.max(0, timingEstimate.phaseDurationsMs[phase] ?? 0));
    const durations = rawDurations.some((duration) => duration > 0) ? rawDurations : rawDurations.map(() => 1);
    const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);
    const completedDuration = durations.slice(0, Math.max(0, phaseIndex)).reduce((sum, duration) => sum + duration, 0);
    const phaseDuration = Math.max(1, durations[phaseIndex] ?? 1);
    const phaseStartedAt = performance.now();
    let frameId = 0;
    const update = (now: number) => {
      const elapsed = Math.max(0, now - phaseStartedAt);
      const withinPhase = elapsed <= phaseDuration ? 0.85 * (elapsed / phaseDuration) : 0.85 + 0.14 * (1 - Math.exp(-(elapsed - phaseDuration) / phaseDuration));
      const nextValue = Math.min(99, ((completedDuration + phaseDuration * Math.min(0.99, withinPhase)) / totalDuration) * 100);
      const monotonicValue = Math.max(valueRef.current, nextValue);
      valueRef.current = monotonicValue;
      setValue(monotonicValue);
      frameId = window.requestAnimationFrame(update);
    };
    frameId = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frameId);
  }, [progressPhase, runKey, timingEstimate]);

  const isDeterminate = value !== null;
  return <div className="mt-3 w-full max-w-md" role="progressbar" aria-label="歌を作っています" aria-valuemin={isDeterminate ? 0 : undefined} aria-valuemax={isDeterminate ? 100 : undefined} aria-valuenow={isDeterminate ? Math.round(value) : undefined} aria-valuetext={isDeterminate ? undefined : "歌を作っています"}>
    <div className="h-1.5 overflow-hidden rounded-full bg-orange-100" aria-hidden="true">
      {isDeterminate ? <div className="h-full rounded-full bg-orange-400 transition-[width] duration-200" style={{ width: `${value}%` }} /> : <div className="h-full w-2/5 animate-pulse rounded-full bg-orange-400" />}
    </div>
  </div>;
};

const GenerationJourney: React.FC<GenerationJourneyProps> = ({ stageLabel, drawingData, compact = false, progressPhase, timingEstimate, runKey }) => (
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
          <GenerationProgressBar progressPhase={progressPhase} timingEstimate={timingEstimate} runKey={runKey} />
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
        <GenerationProgressBar progressPhase={progressPhase} timingEstimate={timingEstimate} runKey={runKey} />
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
