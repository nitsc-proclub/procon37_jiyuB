
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

export interface DrawingData {
  strokes: Stroke[];
  imageUri: string;
}

export interface LyricsResponse {
  title: string;
  lines: string[];
  singingKanaLines?: string[];
  identifiedObject: string;
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
}

export interface DemoRecordDetail extends DemoRecordSummary {
  lyrics: LyricsResponse;
  drawingData: DrawingData;
  singingScore: SingingScore | null;
}
