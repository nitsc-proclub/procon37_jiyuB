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
    return estimated;
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
  const elapsedRatio = Math.min(1, Math.max(0, elapsedMs) / durationMs);
  // Most visible movement happens early in a phase. This reduces the catch-up
  // needed when an operation finishes before its P75 estimate.
  const easedRatio = 1 - (1 - elapsedRatio) ** 3;
  return segment.start + (heldEnd - segment.start) * easedRatio;
};

export const smoothlyAdvanceProgress = (currentValue: number, targetValue: number, elapsedMs: number) => {
  if (targetValue <= currentValue) return currentValue;

  // Reaches about 95% of a newly available target in half a second without a visible jump.
  const catchUp = 1 - Math.exp((-3 * Math.max(0, elapsedMs)) / 500);
  return currentValue + (targetValue - currentValue) * catchUp;
};
