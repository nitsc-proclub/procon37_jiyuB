import type { MelodyAccentLineHint, MelodyAccentLevel } from "./melodyService";

const DEV_VOICEVOX_BASE_URL = "/voicevox";
const PROD_VOICEVOX_BASE_URL = "http://127.0.0.1:50021";
const TALK_ACCENT_SPEAKER = 3;

type VoicevoxMora = {
  text: string;
  pitch: number;
};

type VoicevoxAccentPhrase = {
  moras: VoicevoxMora[];
  accent: number;
  pause_mora: VoicevoxMora | null;
};

export type VoicevoxAccentAnalysis = {
  hints: MelodyAccentLineHint[];
  phrasesByLine: VoicevoxAccentPhrase[][];
};

const getVoicevoxBaseUrl = () => (import.meta.env.DEV ? DEV_VOICEVOX_BASE_URL : PROD_VOICEVOX_BASE_URL);

const readErrorText = async (response: Response) => {
  try {
    return await response.text();
  } catch {
    return "";
  }
};

const ensureOk = async (response: Response, defaultMessage: string) => {
  if (response.ok) {
    return;
  }

  const details = await readErrorText(response);
  const suffix = details ? ` ${details}` : "";
  throw new Error(`${defaultMessage} (${response.status})${suffix}`);
};

const toAccentLevel = (pitch: number, lowThreshold: number, highThreshold: number): MelodyAccentLevel => {
  if (pitch <= 0) {
    return "neutral";
  }

  if (pitch <= lowThreshold) {
    return "low";
  }

  if (pitch >= highThreshold) {
    return "high";
  }

  return "mid";
};

const buildLineHint = (phrases: VoicevoxAccentPhrase[]): MelodyAccentLineHint => {
  const pitches = phrases.flatMap((phrase) => phrase.moras.map((mora) => mora.pitch));
  const voicedPitches = pitches.filter((pitch) => pitch > 0).sort((left, right) => left - right);

  if (voicedPitches.length === 0) {
    return {
      levels: pitches.map(() => "neutral"),
    };
  }

  const lowThreshold = voicedPitches[Math.floor((voicedPitches.length - 1) * 0.33)];
  const highThreshold = voicedPitches[Math.ceil((voicedPitches.length - 1) * 0.67)];

  if (highThreshold - lowThreshold < 0.05) {
    return {
      levels: pitches.map((pitch) => (pitch > 0 ? "mid" : "neutral")),
    };
  }

  return {
    levels: pitches.map((pitch) => toAccentLevel(pitch, lowThreshold, highThreshold)),
  };
};

const analyzeAccentLine = async (line: string) => {
  const baseUrl = getVoicevoxBaseUrl();
  const query = new URLSearchParams({
    speaker: String(TALK_ACCENT_SPEAKER),
    text: line,
  });
  const response = await fetch(`${baseUrl}/accent_phrases?${query.toString()}`, {
    method: "POST",
  });

  await ensureOk(response, "VOICEVOX のアクセント解析に失敗しました。");

  return (await response.json()) as VoicevoxAccentPhrase[];
};

export const analyzeAccentLines = async (lines: string[]): Promise<VoicevoxAccentAnalysis> => {
  const phrasesByLine = await Promise.all(lines.map((line) => analyzeAccentLine(line)));

  return {
    hints: phrasesByLine.map(buildLineHint),
    phrasesByLine,
  };
};
