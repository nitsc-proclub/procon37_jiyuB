import { SingingScore } from "../types";

export type LineTiming = {
  lineIndex: number;
  startFrame: number;
  endFrame: number;
};

export const getTimelineLength = (score: SingingScore | null | undefined, lineCount: number) => {
  const scoreFrames = score?.notes.reduce((sum, note) => sum + note.frame_length, 0) ?? 0;
  return scoreFrames > 0 ? scoreFrames : Math.max(0, lineCount);
};

const getLeadingRestFrames = (score: SingingScore | null | undefined) => {
  const firstNote = score?.notes[0];
  return firstNote?.key === null && firstNote.lyric === "" ? firstNote.frame_length : 0;
};

export const buildLineTimings = (score: SingingScore | null | undefined, lineCount: number): LineTiming[] => {
  if (lineCount <= 0) return [];

  const totalFrames = getTimelineLength(score, lineCount);
  const leadingRestFrames = score ? getLeadingRestFrames(score) : 0;
  const phraseFrameLength = (totalFrames - leadingRestFrames) / lineCount;
  if (totalFrames <= 0 || phraseFrameLength <= 0) return [];

  return Array.from({ length: lineCount }, (_, lineIndex) => ({
    lineIndex,
    startFrame: leadingRestFrames + phraseFrameLength * lineIndex,
    endFrame: leadingRestFrames + phraseFrameLength * (lineIndex + 1),
  }));
};

export const getPlaybackTimelinePosition = (
  audio: HTMLAudioElement | null,
  score: SingingScore | null | undefined,
  lineCount: number,
) => {
  if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return 0;
  return (audio.currentTime / audio.duration) * getTimelineLength(score, lineCount);
};

export const findActiveLineTiming = (lineTimings: LineTiming[], currentFrame: number): LineTiming | null => {
  if (lineTimings.length === 0) return null;

  const active = lineTimings.find((timing) => currentFrame >= timing.startFrame && currentFrame < timing.endFrame);
  if (active) return active;

  const first = lineTimings[0];
  const last = lineTimings.at(-1)!;
  if (currentFrame < first.startFrame) return null;
  return currentFrame >= last.endFrame ? last : null;
};

export const getLineStartTimeSeconds = (
  timing: LineTiming,
  audioDuration: number,
  score: SingingScore | null | undefined,
  lineCount: number,
) => {
  const timelineLength = getTimelineLength(score, lineCount);
  if (!Number.isFinite(audioDuration) || audioDuration <= 0 || timelineLength <= 0) return null;
  const exactStartTime = (timing.startFrame / timelineLength) * audioDuration;
  // Seek just inside the line so frame-to-second rounding cannot select the
  // preceding line at their shared boundary.
  return Math.min(audioDuration, exactStartTime + 0.015);
};
