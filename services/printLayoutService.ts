import { DrawingData, LyricsResponse, Stroke } from "../types";

export type PrintStrokeStep = {
  lineIndex: number;
  lyric: string;
  previousStrokeIndexes: number[];
  currentStrokeIndexes: number[];
  cumulativeStrokeIndexes: number[];
  isCompletionStep: boolean;
};

export type PrintSourceSize = {
  width: number;
  height: number;
};

const uniqueSortedIndexes = (indexes: number[]) =>
  Array.from(new Set(indexes)).sort((first, second) => first - second);

export const getPrintSourceSize = (drawingData: DrawingData): PrintSourceSize => {
  const points = drawingData.strokes.flatMap((stroke) => stroke.points);

  if (points.length === 0) {
    return { width: 1, height: 1 };
  }

  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  const size = Math.max(1, Math.ceil(Math.max(maxX, maxY)));

  return { width: size, height: size };
};

const buildGroupStrokeIndexMap = (drawingData: DrawingData) => {
  const groupStrokeIndexMap = new Map<string, number[]>();

  drawingData.strokeGroups?.forEach((group) => {
    groupStrokeIndexMap.set(group.id, group.rawStrokeIndexes);
  });

  return groupStrokeIndexMap;
};

const buildMappedLineStrokeIndexes = (drawingData: DrawingData, lyrics: LyricsResponse) => {
  const groupStrokeIndexMap = buildGroupStrokeIndexMap(drawingData);

  if (!lyrics.lineStrokeMappings?.length || groupStrokeIndexMap.size === 0) {
    return null;
  }

  return lyrics.lines.map((_, lineIndex) => {
    const mapping = lyrics.lineStrokeMappings?.find((item) => item.lineIndex === lineIndex);
    const strokeIndexes =
      mapping?.strokeGroupIds.flatMap((groupId) => groupStrokeIndexMap.get(groupId) ?? []) ?? [];

    return uniqueSortedIndexes(strokeIndexes);
  });
};

const buildFallbackLineStrokeIndexes = (drawingData: DrawingData, lyrics: LyricsResponse) => {
  const lineCount = Math.max(1, lyrics.lines.length);
  const strokeCount = drawingData.strokes.length;

  return lyrics.lines.map((_, lineIndex) => {
    const start = Math.floor((strokeCount * lineIndex) / lineCount);
    const end = Math.floor((strokeCount * (lineIndex + 1)) / lineCount);

    return Array.from({ length: Math.max(0, end - start) }, (__, index) => start + index);
  });
};

export const buildPrintStrokeSteps = (drawingData: DrawingData, lyrics: LyricsResponse): PrintStrokeStep[] => {
  const mappedLineStrokeIndexes = buildMappedLineStrokeIndexes(drawingData, lyrics);
  const lineStrokeIndexes = mappedLineStrokeIndexes ?? buildFallbackLineStrokeIndexes(drawingData, lyrics);
  const allStrokeIndexes = drawingData.strokes.map((_, index) => index);
  const usedStrokeIndexes = new Set<number>();

  return lyrics.lines.map((lyric, lineIndex) => {
    let currentStrokeIndexes = lineStrokeIndexes[lineIndex] ?? [];
    let isCompletionStep = false;

    if (lineIndex === lyrics.lines.length - 1) {
      const missingStrokeIndexes = allStrokeIndexes.filter(
        (strokeIndex) => !usedStrokeIndexes.has(strokeIndex) && !currentStrokeIndexes.includes(strokeIndex),
      );

      if (missingStrokeIndexes.length > 0) {
        isCompletionStep = currentStrokeIndexes.length === 0;
        currentStrokeIndexes = uniqueSortedIndexes([...currentStrokeIndexes, ...missingStrokeIndexes]);
      }
    }

    const previousStrokeIndexes = allStrokeIndexes.filter((strokeIndex) => usedStrokeIndexes.has(strokeIndex));

    currentStrokeIndexes.forEach((strokeIndex) => usedStrokeIndexes.add(strokeIndex));

    const cumulativeStrokeIndexes = uniqueSortedIndexes([...previousStrokeIndexes, ...currentStrokeIndexes]);

    return {
      lineIndex,
      lyric,
      previousStrokeIndexes,
      currentStrokeIndexes,
      cumulativeStrokeIndexes,
      isCompletionStep,
    };
  });
};

export const buildStrokePath = (stroke: Stroke) => {
  if (stroke.points.length === 0) {
    return "";
  }

  if (stroke.points.length === 1) {
    const [point] = stroke.points;
    return `M ${point.x} ${point.y} l 0.1 0`;
  }

  const [firstPoint, ...restPoints] = stroke.points;
  const commands = [`M ${firstPoint.x} ${firstPoint.y}`];

  restPoints.forEach((point) => {
    commands.push(`L ${point.x} ${point.y}`);
  });

  return commands.join(" ");
};
