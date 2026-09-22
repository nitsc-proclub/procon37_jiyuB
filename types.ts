export type MelodyAccentLevel = "low" | "mid" | "high" | "neutral";

export type MelodyAccentLineHint = {
  levels: MelodyAccentLevel[];
  /** Exclusive mora offsets, including long-vowel extensions, without rests. */
  phraseEnds?: number[];
};


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

/** A bounded, image-free description produced by the drawing-understanding stage. */
export interface DrawingAnalysisObjectCandidate {
  label: string;
  confidence: "low" | "medium" | "high";
}

export interface DrawingAnalysisPart {
  id: string;
  shape: string;
  position: string;
  strokeGroupIds: string[];
}

export interface DrawingAnalysis {
  schemaVersion: 1;
  objectCandidates: DrawingAnalysisObjectCandidate[];
  parts: DrawingAnalysisPart[];
  drawingOrder: string[];
}

/** A future A/B choice. It stays compatible with the existing playback pipeline. */
export interface LyricsCandidate extends LyricsResponse {
  candidateId: "candidate-a" | "candidate-b";
}

/** Models actually used; drawingAnalysis is not-run for single-stage generation. */
export interface Phase1ModelInfo {
  drawingAnalysis: string;
  lyricsGeneration: string;
}

export interface Phase1LyricsResponse {
  archiveGenerationTicket?: string;
  voiceJobCapability?: string;
  accentHints?: Partial<Record<LyricsCandidate["candidateId"], MelodyAccentLineHint[]>>;
  pipelineMode: "phase1" | "single";
  drawingAnalysis: DrawingAnalysis | null;
  candidates: LyricsCandidate[];
  selectedCandidateId: "candidate-a" | "candidate-b";
  modelInfo: Phase1ModelInfo;
  /** The exact prompt contract used for this generation. */
  lyricsPromptVersion: string;
  generationId?: string;
  evaluationReceipt?: string;
  evaluationReceiptExpiresAt?: string;
  /** Short-lived Worker grant for this generation's VOICEVOX requests. */
  voiceGrant?: string;
  /** One short-lived synthesis grant per selectable Phase 1 candidate. */
  voiceGrants?: Partial<Record<LyricsCandidate["candidateId"], string>>;
}

export interface GeneratedEkakiUtaResult {
  /** Exact optimized image submitted to the Worker and bound to its archive ticket. */
  generationImageUri?: string;
  archiveGenerationTicket?: string;
  voiceJobCapability?: string;
  lyrics: LyricsResponse;
  accentHints?: Phase1LyricsResponse["accentHints"];
  candidates: LyricsCandidate[] | null;
  drawingAnalysis: DrawingAnalysis | null;
  modelInfo: Phase1ModelInfo | null;
  /** Present for public single/phase1 responses; old local responses may omit it. */
  lyricsPromptVersion: string | null;
  /** Optional Worker-issued metadata; absent for local development and legacy responses. */
  generationId?: string;
  evaluationReceipt?: string;
  evaluationReceiptExpiresAt?: string;
  /** Short-lived Worker grant for this generation's VOICEVOX requests. */
  voiceGrant?: string;
  /** One short-lived synthesis grant per selectable Phase 1 candidate. */
  voiceGrants?: Partial<Record<LyricsCandidate["candidateId"], string>>;
}

/** A browser-only, unsent preference draft for one Phase 1 generation. */
export type EvaluationSelection = LyricsCandidate["candidateId"] | "neither" | null;

export type EvaluationCentralConsent = "not-asked" | "accepted" | "declined";

/** A bounded answer about the subject suggested by DrawingAnalysis. */
export type DrawingSubjectFeedbackChoice = "primary" | "alternate-1" | "alternate-2" | "other";

export type EvaluationRatingDimension = "drawingSongQuality" | "drawingOrderClarity" | "childFriendliness" | "singability";
export type EvaluationRatingValue = "good" | "okay" | "needs-work";
export type EvaluationStructuredRatings = Partial<Record<EvaluationRatingDimension, EvaluationRatingValue>>;

export interface EvaluationSubmissionPayload {
  schemaVersion: 1;
  generationId: string;
  evaluationReceipt: string;
  createdAt: string;
  updatedAt: string;
  consentedAt: string;
  buildId: string;
  experimentRoundId: string | null;
  drawingAnalysisSchemaVersion: DrawingAnalysis["schemaVersion"];
  lyricsPromptVersion: string | null;
  firstImpressionSelection: EvaluationSelection;
  displayOrder: LyricsCandidate["candidateId"][];
  candidates: LyricsCandidate[];
  strokeGroupIds: string[];
  drawingAnalysis: DrawingAnalysis | null;
  modelInfo: Phase1ModelInfo;
  activeCandidateId: LyricsCandidate["candidateId"] | null;
  alternativePreviewed: boolean;
  centralConsent: "accepted";
}

export interface EvaluationSubmissionResponse {
  saved: true;
  duplicate: boolean;
  generationId: string;
}

/** Optional answers collected after playback. The first impression stays in the base evaluation. */
export interface EvaluationFollowUpSubmissionPayload {
  schemaVersion: 1;
  generationId: string;
  evaluationReceipt: string;
  updatedAt: string;
  finalPreferenceSelection: Exclude<EvaluationSelection, null> | null;
  subjectFeedbackChoice: DrawingSubjectFeedbackChoice | null;
  ratings: EvaluationStructuredRatings;
}

export interface EvaluationFollowUpSubmissionResponse {
  saved: true;
  duplicate: boolean;
  generationId: string;
}

export interface EvaluationDraft {
  schemaVersion: 1;
  generationId: string;
  createdAt: string;
  updatedAt: string;
  candidates: LyricsCandidate[];
  /** Candidate IDs in the participant-facing order; IDs themselves never change. */
  displayOrder: LyricsCandidate["candidateId"][];
  selection: EvaluationSelection;
  /** The first-impression preference is immutable after the modal is confirmed. */
  firstImpressionSelection: EvaluationSelection;
  /** A later preference may change without overwriting the first impression. */
  finalPreferenceSelection?: EvaluationSelection;
  /** The candidate currently shown or prepared for playback. */
  activeCandidateId: LyricsCandidate["candidateId"] | null;
  /** Whether the participant has intentionally opened the other candidate. */
  alternativePreviewed: boolean;
  /** Central-storage consent is tracked locally until the D1 API is connected. */
  centralConsent: EvaluationCentralConsent;
  /** Optional, bounded subject feedback. No free text is collected. */
  subjectFeedbackChoice?: DrawingSubjectFeedbackChoice | null;
  /** Four optional, fixed-choice lyric-quality ratings. */
  ratings?: EvaluationStructuredRatings;
  /** Separate consent for a later central follow-up submission. */
  followUpCentralConsent?: EvaluationCentralConsent;
  drawingAnalysis: DrawingAnalysis | null;
  modelInfo: Phase1ModelInfo;
  drawingAnalysisSchemaVersion: DrawingAnalysis["schemaVersion"];
  lyricsPromptVersion: string | null;
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
  /** Browser galleries defer loading the audio Blob until playback. */
  hasAudio?: boolean;
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
  totalGenerations: number;
  recordedGenerations: number;
  unrecordedGenerations: number;
  days: UsageStatsDay[];
}

export const GENERATION_TIMING_PHASES = ["gemini", "accent", "score", "voicevoxQuery", "voicevoxSynthesis", "finalize"] as const;

export type GenerationTimingPhase = (typeof GENERATION_TIMING_PHASES)[number];

export type GenerationTimingDurations = Partial<Record<GenerationTimingPhase, number>>;

/** Anonymous, aggregate-only measurements. This intentionally excludes drawing, lyrics, audio, and age. */
export interface GenerationTimingEntry {
  recordedAt: string;
  success: boolean;
  failedStage: GenerationTimingPhase | null;
  modelName: string | null;
  voicevoxProfile?: string;
  strokeCount: number;
  strokeGroupCount: number;
  pointCount: number;
  lyricLineCount: number;
  noteCount: number;
  totalFrames: number;
  durationsMs: GenerationTimingDurations;
  totalMs: number;
}

export interface GenerationTimingEstimate {
  determinate: boolean;
  sampleCount: number;
  estimatedTotalMs: number;
  phaseDurationsMs: GenerationTimingDurations;
}

export type DebugBundleOutcomeStatus = "success" | "partial" | "error";

export interface DebugBundleManifest {
  format: "cho-ekaki-uta-debug-bundle";
  schemaVersion: 1;
  recordId: string;
  createdAt: string;
  outcome: {
    status: DebugBundleOutcomeStatus;
    failedStage: GenerationTimingPhase | null;
    error: string | null;
  };
  app: {
    buildId: string;
    mode: "full" | "deployment-preview";
    origin: string;
  };
  generation: {
    geminiModel: string | null;
    startedAt: string;
    completedAt: string;
    durationsMs: GenerationTimingDurations;
    playbackKind: "voice" | "animation-only";
    voicevox: "voice" | "unavailable" | "failed" | "not-attempted";
    voicevoxIssue: string | null;
  };
  drawing: {
    image: {
      path: "input.png";
      mimeType: "image/png";
    };
    strokes: Stroke[];
    strokeGroups: StrokeGroup[];
    canvasSize: DrawingCanvasSize | null;
    lineWidth: number | null;
  };
  lyrics: LyricsResponse | null;
  singingScore: SingingScore | null;
  audio: {
    path: "voice.wav";
    mimeType: "audio/wav";
  } | null;
  reporterNote: string | null;
}
