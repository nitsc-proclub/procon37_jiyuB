import { GENERATION_TIMING_PHASES, type GenerationTimingDurations, type GenerationTimingEstimate } from "../types";
import { GENERATION_PROGRESS_SEGMENTS } from "../utils/generationProgress";

const key = (profile: string) => `ekaki-progress-v2:${profile}`;
function read(profile: string): GenerationTimingDurations[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key(profile)) ?? "[]");
    return Array.isArray(stored) ? stored.filter(item => item && typeof item === "object").slice(-10) : [];
  } catch { return []; }
}

/** Synchronous snapshot, shared by both builds; never replaced mid-generation. */
export function readTimingEstimate(profile: string): GenerationTimingEstimate {
  const samples = read(profile);
  const phaseDurationsMs: GenerationTimingDurations = {};
  for (const phase of GENERATION_TIMING_PHASES) {
    const fallback = GENERATION_PROGRESS_SEGMENTS[phase].fallbackDurationMs;
    const values = samples.map(sample => sample[phase]).filter((value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0 && value < 300_000).sort((a, b) => a - b);
    const learned = values[Math.max(0, Math.ceil(values.length * .75) - 1)] ?? fallback;
    // Gradual learning, without a sudden third-sample mode switch.
    const weight = Math.min(.75, values.length / 12);
    phaseDurationsMs[phase] = fallback * (1 - weight) + Math.max(fallback * .5, learned) * weight;
  }
  return { determinate: true, sampleCount: samples.length, phaseDurationsMs,
    estimatedTotalMs: Object.values(phaseDurationsMs).reduce((sum, value) => sum + value, 0) };
}

export function rememberTiming(profile: string, durations: GenerationTimingDurations) {
  try { localStorage.setItem(key(profile), JSON.stringify([...read(profile), durations].slice(-10))); }
  catch { /* Estimates are optional when browser storage is disabled/full. */ }
}
