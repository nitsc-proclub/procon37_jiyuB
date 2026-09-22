import { GenerationTimingEstimate, GenerationTimingPhase } from "../types";

export type GenerationProgressSegment = {
  start: number;
  end: number;
  fallbackDurationMs: number;
};

// Accent analysis and score building are separate measured events, but form one
// small, child-facing "preparing the song" part of the journey.
export const GENERATION_PROGRESS_SEGMENTS: Record<GenerationTimingPhase, GenerationProgressSegment> = {
  gemini: { start: 0, end: 84, fallbackDurationMs: 16_000 },
  accent: { start: 84, end: 84.5, fallbackDurationMs: 100 },
  score: { start: 84.5, end: 85, fallbackDurationMs: 40 },
  voicevoxQuery: { start: 85, end: 94, fallbackDurationMs: 1_400 },
  voicevoxSynthesis: { start: 94, end: 99, fallbackDurationMs: 1_200 },
  finalize: { start: 99, end: 100, fallbackDurationMs: 350 },
};

const SEGMENT_END_GAP = 0.2;

export const getGenerationPhaseDurationMs = (
  phase: GenerationTimingPhase,
  timingEstimate?: GenerationTimingEstimate | null,
) => {
  const estimated = timingEstimate?.phaseDurationsMs[phase];
  if (timingEstimate?.determinate && Number.isFinite(estimated) && estimated && estimated > 0) {
    // A few fast requests must not make the next run race ahead.
    return Math.max(GENERATION_PROGRESS_SEGMENTS[phase].fallbackDurationMs * 0.5, estimated);
  }

  return GENERATION_PROGRESS_SEGMENTS[phase].fallbackDurationMs;
};

/**
 * The target deliberately stops just short of a segment end. The next real
 * generation event unlocks that boundary, so an estimate can never claim work
 * that has not actually completed.
 */
export const getGenerationPhaseProgressTarget = (
  phase: GenerationTimingPhase,
  elapsedMs: number,
  timingEstimate?: GenerationTimingEstimate | null,
) => {
  const segment = GENERATION_PROGRESS_SEGMENTS[phase];
  const durationMs = Math.max(1, getGenerationPhaseDurationMs(phase, timingEstimate));
  const heldEnd = Math.max(segment.start, segment.end - SEGMENT_END_GAP);
  const elapsedRatio = Math.max(0, elapsedMs) / durationMs;
  const easedRatio = 1 - Math.exp(-elapsedRatio);
  return segment.start + (heldEnd - segment.start) * easedRatio;
};

export const smoothlyAdvanceProgress = (currentValue: number, targetValue: number, elapsedMs: number) => {
  if (targetValue <= currentValue) return currentValue;

  // Bound both speed and a suspended tab's first frame. Real phase changes can
  // unlock large targets, but must not cause a visible leap.
  const frameMs = Math.min(50, Math.max(0, elapsedMs));
  const catchUp = 1 - Math.exp((-3 * frameMs) / 500);
  return currentValue + Math.min((targetValue - currentValue) * catchUp, 22 * frameMs / 1000);
};

export const advanceCompletedProgress = (value: number, elapsedMs: number) =>
  Math.min(100, value + 40 * Math.min(50, Math.max(0, elapsedMs)) / 1000);
