
export interface Point {
  x: number;
  y: number;
  timestamp: number;
}

export interface Stroke {
  points: Point[];
  startTime: number;
  endTime: number;
}

export interface DrawingCanvasSize {
  width: number;
  height: number;
}

export interface DrawingData {
  strokes: Stroke[];
  imageUri: string;
  strokeGroups?: StrokeGroup[];
  /** Logical coordinate space used by every stroke. Omitted by legacy records. */
  canvasSize?: DrawingCanvasSize;
  /** Stroke width in the logical coordinate space. Omitted by legacy records. */
  lineWidth?: number;
}

export interface StrokeBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface StrokeGroup {
  id: string;
  rawStrokeIndexes: number[];
  bounds: StrokeBounds;
  startTime: number;
  endTime: number;
  length: number;
}

export interface LyricStrokeMapping {
  lineIndex: number;
  strokeGroupIds: string[];
}

export interface LyricsResponse {
  title: string;
  lines: string[];
  singingKanaLines?: string[];
  identifiedObject: string;
  lineStrokeMappings?: LyricStrokeMapping[];
  modelName?: string;
}

export interface SingingNote {
  lyric: string;
  key: number | null;
  frame_length: number;
}

export interface SingingScore {
  notes: SingingNote[];
}

export interface DemoRecordSummary {
  recordId: string;
  savedAt: string;
  title: string;
  identifiedObject: string;
  imageUrl: string;
  audioUrl: string | null;
  participantAge: number | null;
  isFavorite: boolean;
}

export interface DemoRecordDetail extends DemoRecordSummary {
  lyrics: LyricsResponse;
  drawingData: DrawingData;
  singingScore: SingingScore | null;
}

export interface UsageStatsDay {
  date: string;
  generationCount: number;
  recordedCount: number;
  unrecordedCount: number;
}

export interface UsageStats {
  totalExperiences: number;
  totalGenerations: number;
  recordedGenerations: number;
  unrecordedGenerations: number;
  days: UsageStatsDay[];
}
