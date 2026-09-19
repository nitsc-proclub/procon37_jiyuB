export type LyricsCandidateCount = 1 | 2;

const DEFAULT_LYRICS_CANDIDATE_COUNT: LyricsCandidateCount = 1;
const DEFAULT_GEMINI_IMAGE_MAX_DIMENSION = 0;

/** Parse the shared generation setting used by Vite middleware and the Worker. */
export const resolveLyricsCandidateCount = (value: unknown): LyricsCandidateCount => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized === "1" ? 1 : normalized === "2" ? 2 : DEFAULT_LYRICS_CANDIDATE_COUNT;
};

/** Maximum image dimension used for the browser-to-Gemini request. Zero disables resizing. */
export const resolveGeminiImageMaxDimension = (value: unknown): number => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0) return DEFAULT_GEMINI_IMAGE_MAX_DIMENSION;

  const dimension = Number(normalized);
  return Number.isInteger(dimension) && dimension >= 0 && dimension <= 4096
    ? dimension
    : DEFAULT_GEMINI_IMAGE_MAX_DIMENSION;
};

/** Feature flag for builds that must not collect or display participant age. */
export const resolveParticipantAgeUiHidden = (value: unknown): boolean =>
  typeof value === "string" && value.trim().toLowerCase() === "true";
