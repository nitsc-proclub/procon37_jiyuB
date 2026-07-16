import React, { useEffect, useMemo, useRef, useState } from "react";
import { DrawingData, LyricStrokeMapping, Point, SingingScore } from "../types";

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

type LineTiming = {
  lineIndex: number;
  startFrame: number;
  endFrame: number;
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

const getLeadingRestFrames = (score: SingingScore) => {
  const firstNote = score.notes[0];
  return firstNote?.key === null && firstNote.lyric === "" ? firstNote.frame_length : 0;
};

const buildLineTimings = (score: SingingScore | null | undefined, lineCount = 0) => {
  if (!score || lineCount <= 0) {
    return [];
  }

  const totalFrames = score.notes.reduce((sum, note) => sum + note.frame_length, 0);
  const leadingRestFrames = getLeadingRestFrames(score);
  const phraseFrameLength = (totalFrames - leadingRestFrames) / lineCount;

  if (totalFrames <= 0 || phraseFrameLength <= 0) {
    return [];
  }

  return Array.from({ length: lineCount }, (_, lineIndex) => ({
    lineIndex,
    startFrame: leadingRestFrames + phraseFrameLength * lineIndex,
    endFrame: leadingRestFrames + phraseFrameLength * (lineIndex + 1),
  }));
};

const getAudioProgress = (audio: HTMLAudioElement | null, animationEndProgress: number) => {
  if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
    return 0;
  }

  const safeEndProgress = clamp(animationEndProgress, 0.05, 1);
  const rawProgress = audio.currentTime / audio.duration;
  return clamp(rawProgress / safeEndProgress, 0, 1);
};

const getCurrentFrame = (audio: HTMLAudioElement | null, score: SingingScore | null | undefined) => {
  if (!audio || !score || !Number.isFinite(audio.duration) || audio.duration <= 0) {
    return 0;
  }

  const totalFrames = score.notes.reduce((sum, note) => sum + note.frame_length, 0);
  return (audio.currentTime / audio.duration) * totalFrames;
};

const findCurrentLineTiming = (lineTimings: LineTiming[], currentFrame: number) =>
  lineTimings.find((timing) => currentFrame >= timing.startFrame && currentFrame < timing.endFrame) ??
  lineTimings.at(-1) ??
  null;

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
      drawPathData(pathData, progress);
    };

    const drawLineSyncedPath = () => {
      prepareContext();

      const currentFrame = getCurrentFrame(audioRef.current, singingScore);
      const currentLineTiming = findCurrentLineTiming(lineTimings, currentFrame);

      if (!currentLineTiming || !lineStrokeMappings) {
        drawPathData(pathData, getAudioProgress(audioRef.current, animationEndProgress));
        return;
      }

      const currentLineFrameLength = currentLineTiming.endFrame - currentLineTiming.startFrame;
      const currentLineProgress =
        currentLineFrameLength > 0 ? clamp((currentFrame - currentLineTiming.startFrame) / currentLineFrameLength, 0, 1) : 1;

      lineStrokeMappings.forEach((mapping) => {
        if (mapping.lineIndex > currentLineTiming.lineIndex) {
          return;
        }

        const progress = mapping.lineIndex < currentLineTiming.lineIndex ? 1 : currentLineProgress;
        const linePathData = combinePathData(
          mapping.strokeGroupIds
            .map((groupId) => groupPathMap.get(groupId))
            .filter((groupPathData): groupPathData is PathData => !!groupPathData),
        );

        drawPathData(linePathData, progress);
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

    let animationFrameId = 0;

    const drawFrame = () => {
      if (canUseLineSync) {
        drawLineSyncedPath();
      } else {
        drawAnimatedPath(getAudioProgress(audioRef.current, animationEndProgress));
      }

      animationFrameId = window.requestAnimationFrame(drawFrame);
    };

    drawFrame();

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [
    animationEndProgress,
    audioRef,
    canUseLineSync,
    canvasSize,
    drawingData.lineWidth,
    groupPathMap,
    lineStrokeMappings,
    lineTimings,
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
