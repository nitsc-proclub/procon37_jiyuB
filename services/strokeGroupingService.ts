import { Stroke, StrokeBounds, StrokeGroup } from "../types";

const ENDPOINT_MERGE_DISTANCE = 14;
const SHORT_STROKE_LENGTH = 28;
const BOUNDS_MERGE_DISTANCE = 20;
const MAX_MERGE_TIME_GAP_MS = 900;

type StrokeSummary = {
  rawStrokeIndex: number;
  bounds: StrokeBounds;
  startTime: number;
  endTime: number;
  length: number;
  startPoint: { x: number; y: number } | null;
  endPoint: { x: number; y: number } | null;
};

const getPointDistance = (first: { x: number; y: number }, second: { x: number; y: number }) =>
  Math.hypot(second.x - first.x, second.y - first.y);

const getBoundsDistance = (first: StrokeBounds, second: StrokeBounds) => {
  const xGap = Math.max(0, Math.max(first.minX, second.minX) - Math.min(first.maxX, second.maxX));
  const yGap = Math.max(0, Math.max(first.minY, second.minY) - Math.min(first.maxY, second.maxY));
  return Math.hypot(xGap, yGap);
};

const mergeBounds = (first: StrokeBounds, second: StrokeBounds): StrokeBounds => ({
  minX: Math.min(first.minX, second.minX),
  minY: Math.min(first.minY, second.minY),
  maxX: Math.max(first.maxX, second.maxX),
  maxY: Math.max(first.maxY, second.maxY),
});

const summarizeStroke = (stroke: Stroke, rawStrokeIndex: number): StrokeSummary | null => {
  if (stroke.points.length === 0) {
    return null;
  }

  const bounds = {
    minX: Math.min(...stroke.points.map((point) => point.x)),
    minY: Math.min(...stroke.points.map((point) => point.y)),
    maxX: Math.max(...stroke.points.map((point) => point.x)),
    maxY: Math.max(...stroke.points.map((point) => point.y)),
  };
  const length = stroke.points.slice(1).reduce((sum, point, index) => {
    const previousPoint = stroke.points[index];
    return sum + getPointDistance(previousPoint, point);
  }, 0);

  return {
    rawStrokeIndex,
    bounds,
    startTime: stroke.startTime,
    endTime: stroke.endTime,
    length,
    startPoint: stroke.points[0] ?? null,
    endPoint: stroke.points.at(-1) ?? null,
  };
};

const shouldMergeSummaries = (previous: StrokeSummary, next: StrokeSummary) => {
  const timeGap = next.startTime - previous.endTime;

  if (timeGap < 0 || timeGap > MAX_MERGE_TIME_GAP_MS) {
    return false;
  }

  const endpointDistance =
    previous.endPoint && next.startPoint ? getPointDistance(previous.endPoint, next.startPoint) : Number.POSITIVE_INFINITY;
  const boundsDistance = getBoundsDistance(previous.bounds, next.bounds);
  const hasShortStroke = previous.length <= SHORT_STROKE_LENGTH || next.length <= SHORT_STROKE_LENGTH;

  return endpointDistance <= ENDPOINT_MERGE_DISTANCE || (hasShortStroke && boundsDistance <= BOUNDS_MERGE_DISTANCE);
};

const createGroup = (summaries: StrokeSummary[], groupIndex: number): StrokeGroup => {
  const bounds = summaries.map((summary) => summary.bounds).reduce(mergeBounds);

  return {
    id: `g${groupIndex + 1}`,
    rawStrokeIndexes: summaries.map((summary) => summary.rawStrokeIndex),
    bounds,
    startTime: Math.min(...summaries.map((summary) => summary.startTime)),
    endTime: Math.max(...summaries.map((summary) => summary.endTime)),
    length: summaries.reduce((sum, summary) => sum + summary.length, 0),
  };
};

export const groupStrokes = (strokes: Stroke[]): StrokeGroup[] => {
  const summaries = strokes
    .map((stroke, index) => summarizeStroke(stroke, index))
    .filter((summary): summary is StrokeSummary => summary !== null);
  const groups: StrokeGroup[] = [];
  let currentGroup: StrokeSummary[] = [];

  summaries.forEach((summary) => {
    const previousSummary = currentGroup.at(-1);

    if (!previousSummary || shouldMergeSummaries(previousSummary, summary)) {
      currentGroup.push(summary);
      return;
    }

    groups.push(createGroup(currentGroup, groups.length));
    currentGroup = [summary];
  });

  if (currentGroup.length > 0) {
    groups.push(createGroup(currentGroup, groups.length));
  }

  return groups;
};
