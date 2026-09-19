import { SingingScore } from "../types";
import { getScoreFrameLength } from "../utils/playbackTiming";

/** VOICEVOX and the score format both use 93.75 frames per second. */
export const SCORE_FRAMES_PER_SECOND = 93.75;

const SILENT_WAV_SAMPLE_RATE = 8_000;
const SILENT_WAV_BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

export const getScoreDurationSeconds = (score: SingingScore) => {
  const totalFrames = getScoreFrameLength(score);
  return totalFrames / SCORE_FRAMES_PER_SECOND;
};

/**
 * Creates a small PCM WAV whose duration is exactly the score duration to the
 * nearest sample.  It is deliberately silent: the audio element is used as a
 * robust, seekable clock for the drawing animation and karaoke highlight.
 */
export const createSilentPlaybackAudio = (score: SingingScore): Blob => {
  const durationSeconds = getScoreDurationSeconds(score);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("楽譜の再生時間を作れませんでした。");
  }

  const sampleCount = Math.max(1, Math.round(durationSeconds * SILENT_WAV_SAMPLE_RATE));
  const dataSize = sampleCount * SILENT_WAV_BYTES_PER_SAMPLE;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SILENT_WAV_SAMPLE_RATE, true);
  view.setUint32(28, SILENT_WAV_SAMPLE_RATE * SILENT_WAV_BYTES_PER_SAMPLE, true);
  view.setUint16(32, SILENT_WAV_BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  return new Blob([bytes], { type: "audio/wav" });
};
