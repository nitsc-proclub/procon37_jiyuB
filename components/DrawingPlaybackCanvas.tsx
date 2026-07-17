import React, { useEffect, useMemo, useRef, useState } from "react";
import { DrawingData, LyricStrokeMapping, Point, SingingScore } from "../types";
import { buildLineTimings, findActiveLineTiming, getPlaybackTimelinePosition } from "../utils/playbackTiming";

export type DrawingDisplayMode = "animated" | "static";

interface DrawingPlaybackCanvasProps {
  drawingData: DrawingData;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  mode: DrawingDisplayMode;
  animationEndProgress?: number;
  lineStrokeMappings?: LyricStrokeMapping[];
  singingScore?: SingingScore | null;
  lyricLineCount?: number;
}

type CanvasSize = {
  width: number;
  height: number;
  dpr: number;
};

type SourceSize = {
  width: number;
  height: number;
};

type PathSegment =
  | {
      type: "line";
      from: Point;
      to: Point;
      startLength: number;
      length: number;
    }
  | {
      type: "dot";
      point: Point;
      startLength: number;
      length: number;
    };

type PathData = {
  segments: PathSegment[];
  totalLength: number;
};

const LINE_WIDTH = 4;
const DOT_LENGTH = 1;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const getDistance = (from: Point, to: Point) => Math.hypot(to.x - from.x, to.y - from.y);

const getFallbackSourceSize = (drawingData: DrawingData): SourceSize => {
  const savedSize = drawingData.canvasSize;

  if (
    savedSize &&
    Number.isFinite(savedSize.width) &&
    Number.isFinite(savedSize.height) &&
    savedSize.width > 0 &&
    savedSize.height > 0
  ) {
    return savedSize;
  }

  const points = drawingData.strokes.flatMap((stroke) => stroke.points);

  if (points.length === 0) {
    return { width: 1, height: 1 };
  }

  return {
    width: Math.max(1, Math.ceil(Math.max(...points.map((point) => point.x)))),
    height: Math.max(1, Math.ceil(Math.max(...points.map((point) => point.y)))),
  };
};

const buildPathSegmentsFromStrokeIndexes = (drawingData: DrawingData, strokeIndexes: number[]): PathData => {
  const segments: PathSegment[] = [];
  let totalLength = 0;

  strokeIndexes.forEach((strokeIndex) => {
    const stroke = drawingData.strokes[strokeIndex];

    if (!stroke) {
      return;
    }

    if (stroke.points.length === 0) {
      return;
    }

    if (stroke.points.length === 1) {
      segments.push({
        type: "dot",
        point: stroke.points[0],
        startLength: totalLength,
        length: DOT_LENGTH,
      });
      totalLength += DOT_LENGTH;
      return;
    }

    let strokeLength = 0;

    stroke.points.slice(1).forEach((point, index) => {
      const from = stroke.points[index];
      const length = getDistance(from, point);

      if (length <= 0) {
        return;
      }

      segments.push({
        type: "line",
        from,
        to: point,
        startLength: totalLength,
        length,
      });
      totalLength += length;
      strokeLength += length;
    });

    if (strokeLength === 0) {
      segments.push({
        type: "dot",
        point: stroke.points[0],
        startLength: totalLength,
        length: DOT_LENGTH,
      });
      totalLength += DOT_LENGTH;
    }
  });

  return {
    segments,
    totalLength,
  };
};

const buildPathSegments = (drawingData: DrawingData) =>
  buildPathSegmentsFromStrokeIndexes(
    drawingData,
    drawingData.strokes.map((_, index) => index),
  );

const buildGroupPathMap = (drawingData: DrawingData) => {
  const pathMap = new Map<string, PathData>();

  drawingData.strokeGroups?.forEach((group) => {
    pathMap.set(group.id, buildPathSegmentsFromStrokeIndexes(drawingData, group.rawStrokeIndexes));
  });

  return pathMap;
};

const combinePathData = (pathDataItems: PathData[]): PathData => {
  const segments: PathSegment[] = [];
  let totalLength = 0;

  pathDataItems.forEach((pathData) => {
    pathData.segments.forEach((segment) => {
      segments.push({
        ...segment,
        startLength: totalLength + segment.startLength,
      });
    });

    totalLength += pathData.totalLength;
  });

  return {
    segments,
    totalLength,
  };
};

const getAudioProgress = (audio: HTMLAudioElement | null, animationEndProgress: number) => {
  if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
    return 0;
  }

  const safeEndProgress = clamp(animationEndProgress, 0.05, 1);
  const rawProgress = audio.currentTime / audio.duration;
  return clamp(rawProgress / safeEndProgress, 0, 1);
};

const DrawingPlaybackCanvas: React.FC<DrawingPlaybackCanvasProps> = ({
  drawingData,
  audioRef,
  mode,
  animationEndProgress = 1,
  lineStrokeMappings,
  singingScore,
  lyricLineCount = lineStrokeMappings?.length ?? 0,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 1, height: 1, dpr: 1 });
  const [sourceSize, setSourceSize] = useState<SourceSize>(() => getFallbackSourceSize(drawingData));
  const pathData = useMemo(() => buildPathSegments(drawingData), [drawingData]);
  const groupPathMap = useMemo(() => buildGroupPathMap(drawingData), [drawingData]);
  const linePathDataItems = useMemo(
    () =>
      lineStrokeMappings?.map((mapping) => ({
        lineIndex: mapping.lineIndex,
        pathData: combinePathData(
          mapping.strokeGroupIds
            .map((groupId) => groupPathMap.get(groupId))
            .filter((groupPathData): groupPathData is PathData => !!groupPathData),
        ),
      })) ?? [],
    [groupPathMap, lineStrokeMappings],
  );
  const lineTimings = useMemo(() => buildLineTimings(singingScore, lyricLineCount), [lyricLineCount, singingScore]);
  const canUseLineSync =
    !!lineStrokeMappings?.length && !!drawingData.strokeGroups?.length && groupPathMap.size > 0 && lineTimings.length > 0;

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const updateCanvasSize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      setCanvasSize({ width, height, dpr });
    };

    updateCanvasSize();

    const observer = new ResizeObserver(updateCanvasSize);
    observer.observe(canvas);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
      setSourceSize(
        drawingData.canvasSize ?? {
          width: Math.max(1, image.naturalWidth),
          height: Math.max(1, image.naturalHeight),
        },
      );
    };
    image.onerror = () => {
      imageRef.current = null;
      setSourceSize(getFallbackSourceSize(drawingData));
    };
    image.src = drawingData.imageUri;

    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [drawingData]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return;
    }

    const scalePoint = (point: Point) => ({
      x: point.x * (canvasSize.width / sourceSize.width),
      y: point.y * (canvasSize.height / sourceSize.height),
    });

    const prepareContext = () => {
      context.setTransform(canvasSize.dpr, 0, 0, canvasSize.dpr, 0, 0);
      context.clearRect(0, 0, canvasSize.width, canvasSize.height);
      context.fillStyle = "white";
      context.fillRect(0, 0, canvasSize.width, canvasSize.height);
      context.lineCap = "round";
      context.lineJoin = "round";
      const coordinateLineWidth = drawingData.lineWidth ?? LINE_WIDTH;
      context.lineWidth = coordinateLineWidth * Math.min(canvasSize.width / sourceSize.width, canvasSize.height / sourceSize.height);
      context.strokeStyle = "#333";
      context.fillStyle = "#333";
      context.shadowBlur = 0;
      context.shadowColor = "transparent";
    };

    const baseLineWidth = (drawingData.lineWidth ?? LINE_WIDTH) * Math.min(canvasSize.width / sourceSize.width, canvasSize.height / sourceSize.height);
    const setPathStyle = (color: string, widthMultiplier = 1, glow = false) => {
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = baseLineWidth * widthMultiplier;
      context.shadowColor = glow ? "rgba(249, 115, 22, 0.55)" : "transparent";
      context.shadowBlur = glow ? Math.max(5, baseLineWidth * 2.5) : 0;
    };

    const drawPathData = (targetPathData: PathData, progress: number) => {
      const visibleLength = targetPathData.totalLength * clamp(progress, 0, 1);

      targetPathData.segments.forEach((segment) => {
        const segmentProgress = visibleLength - segment.startLength;

        if (segmentProgress <= 0) {
          return;
        }

        if (segment.type === "dot") {
          const point = scalePoint(segment.point);
          context.beginPath();
          context.arc(point.x, point.y, context.lineWidth / 2, 0, Math.PI * 2);
          context.fill();
          return;
        }

        const from = scalePoint(segment.from);
        const to = scalePoint(segment.to);
        const ratio = clamp(segmentProgress / segment.length, 0, 1);
        const partialTo = {
          x: from.x + (to.x - from.x) * ratio,
          y: from.y + (to.y - from.y) * ratio,
        };

        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(partialTo.x, partialTo.y);
        context.stroke();
      });
    };

    const drawAnimatedPath = (progress: number) => {
      prepareContext();
      setPathStyle("rgba(51, 65, 85, 0.16)");
      drawPathData(pathData, 1);
      setPathStyle("#334155");
      drawPathData(pathData, progress);
    };

    const drawLineSyncedPath = () => {
      prepareContext();

      setPathStyle("rgba(51, 65, 85, 0.16)");
      drawPathData(pathData, 1);

      const currentFrame = getPlaybackTimelinePosition(audioRef.current, singingScore, lyricLineCount);
      const currentLineTiming = findActiveLineTiming(lineTimings, currentFrame);

      if (!currentLineTiming || !lineStrokeMappings) {
        setPathStyle("#334155");
        drawPathData(pathData, 1);
        return;
      }

      linePathDataItems.forEach((item) => {
        if (item.lineIndex < currentLineTiming.lineIndex) {
          setPathStyle("#334155");
          drawPathData(item.pathData, 1);
        } else if (item.lineIndex === currentLineTiming.lineIndex) {
          setPathStyle("#f97316", 1.75, true);
          drawPathData(item.pathData, 1);
        }
      });
    };

    const drawStaticImage = () => {
      prepareContext();

      if (imageRef.current) {
        context.drawImage(imageRef.current, 0, 0, canvasSize.width, canvasSize.height);
        return;
      }

      drawAnimatedPath(1);
    };

    if (mode === "static") {
      drawStaticImage();
      return;
    }

    let animationFrameId: number | null = null;
    const audio = audioRef.current;

    const drawCurrentState = () => {
      if (
        !audio ||
        !Number.isFinite(audio.duration) ||
        audio.duration <= 0 ||
        audio.ended ||
        audio.currentTime >= audio.duration - 0.02 ||
        (audio.paused && audio.currentTime <= 0.02)
      ) {
        drawStaticImage();
        return;
      }

      if (canUseLineSync) {
        drawLineSyncedPath();
      } else {
        drawAnimatedPath(getAudioProgress(audio, animationEndProgress));
      }
    };

    const stopLoop = () => {
      if (animationFrameId === null) return;
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    };

    const drawLoop = () => {
      drawCurrentState();
      if (audio && !audio.paused && !audio.ended) {
        animationFrameId = window.requestAnimationFrame(drawLoop);
      } else {
        animationFrameId = null;
      }
    };

    const startLoop = () => {
      stopLoop();
      drawLoop();
    };

    const settleFrame = () => {
      stopLoop();
      drawCurrentState();
    };

    const resumeAfterSeek = () => {
      if (audio.paused || audio.ended) {
        settleFrame();
      } else {
        startLoop();
      }
    };

    drawCurrentState();

    if (!audio) return;

    audio.addEventListener("play", startLoop);
    audio.addEventListener("pause", settleFrame);
    audio.addEventListener("ended", settleFrame);
    audio.addEventListener("seeking", settleFrame);
    audio.addEventListener("seeked", resumeAfterSeek);
    audio.addEventListener("timeupdate", drawCurrentState);
    audio.addEventListener("loadedmetadata", drawCurrentState);

    if (!audio.paused && !audio.ended) {
      startLoop();
    }

    return () => {
      stopLoop();
      audio.removeEventListener("play", startLoop);
      audio.removeEventListener("pause", settleFrame);
      audio.removeEventListener("ended", settleFrame);
      audio.removeEventListener("seeking", settleFrame);
      audio.removeEventListener("seeked", resumeAfterSeek);
      audio.removeEventListener("timeupdate", drawCurrentState);
      audio.removeEventListener("loadedmetadata", drawCurrentState);
    };
  }, [
    animationEndProgress,
    audioRef,
    canUseLineSync,
    canvasSize,
    drawingData.lineWidth,
    groupPathMap,
    lineStrokeMappings,
    linePathDataItems,
    lineTimings,
    lyricLineCount,
    mode,
    pathData,
    singingScore,
    sourceSize,
  ]);

  return (
    <div className="h-full w-full bg-white">
      <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />
    </div>
  );
};

export default DrawingPlaybackCanvas;
