export type LyricsCandidateCount = 1 | 2;

const DEFAULT_LYRICS_CANDIDATE_COUNT: LyricsCandidateCount = 1;

/** Parse the shared generation setting used by Vite middleware and the Worker. */
export const resolveLyricsCandidateCount = (value: unknown): LyricsCandidateCount => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized === "1" ? 1 : normalized === "2" ? 2 : DEFAULT_LYRICS_CANDIDATE_COUNT;
};

/** Feature flag for builds that must not collect or display participant age. */
export const resolveParticipantAgeUiHidden = (value: unknown): boolean =>
  typeof value === "string" && value.trim().toLowerCase() === "true";
