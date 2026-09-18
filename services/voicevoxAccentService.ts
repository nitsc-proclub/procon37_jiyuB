import type { MelodyAccentLineHint, MelodyAccentLevel } from "./melodyService";
import { getSingingMoras } from "./melodyService";
import { ensureVoicevoxOk, fetchLocalVoicevox, isDevelopmentVoicevox } from "./voicevoxHttp";

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

const vowelOf = (mora: string): string | undefined => {
  const last = mora.at(-1) ?? "";
  for (const [vowel, kana] of Object.entries({
    あ: "あかがさざただなはばぱまやらわぁゃゎ",
    い: "いきぎしじちぢにひびぴみりぃ",
    う: "うくぐすずつづぬふぶぷむゆるゔぅゅ",
    え: "えけげせぜてでねへべぺめれぇ",
    お: "おこごそぞとどのほぼぽもよろをぉょ",
  })) {
    if (last && kana.includes(last)) return vowel;
  }
  return undefined;
};

const normalizeMoras = (moras: string[]): string[] => {
  const normalized: string[] = [];
  for (const mora of moras) {
    normalized.push(mora === "ー" ? vowelOf(normalized.at(-1) ?? "") ?? "ー" : mora);
  }
  return normalized;
};

/** Do not align by count alone: a changed reading must not shift phrase/pitch hints. */
export const buildAlignedAccentHint = (line: string, phrases: VoicevoxAccentPhrase[]): MelodyAccentLineHint => {
  const source = normalizeMoras(getSingingMoras(line));
  const talk = phrases.flatMap((phrase) => phrase.moras);
  const talkMoras = talk.map((mora) => mora.text.normalize("NFKC") === "ー" ? ["ー"] : getSingingMoras(mora.text));
  if (talkMoras.some((moras) => moras.length !== 1)) return { levels: [] };
  const reading = normalizeMoras(talkMoras.flat());
  let end = 0;
  const phraseEnds = phrases.filter((phrase) => phrase.moras.length > 0).map((phrase) => (end += phrase.moras.length));
  const matches = (mora: string, index: number) => {
    if (mora === reading[index]) return true;
    // Talk expands orthographic long vowels (ショウ -> ショオ, エイ -> エエ).
    const previousVowel = vowelOf(source[index - 1] ?? "");
    if ((mora === "う" && previousVowel === "お" && reading[index] === "お")
      || (mora === "い" && previousVowel === "え" && reading[index] === "え")) return true;
    // Particle readings are accepted only at an accent-phrase end, never by
    // arbitrary substitution or by inserting/deleting a mora.
    const particle = ({ を: "お", は: "わ", へ: "え" } as Record<string, string>)[mora];
    return phraseEnds.includes(index + 1) && particle === reading[index];
  };
  if (source.length === 0 || source.length !== reading.length
    || source.some((mora, index) => !matches(mora, index))) return { levels: [] };
  return {
    ...buildLineHint(phrases),
    phraseEnds,
  };
};

const analyzeAccentLine = async (line: string) => {
  if (!isDevelopmentVoicevox()) {
    throw new Error("アクセント解析は開発時のローカルVOICEVOXでのみ利用できます。");
  }

  const query = new URLSearchParams({
    speaker: String(TALK_ACCENT_SPEAKER),
    text: line,
  });
  const response = await fetchLocalVoicevox(`/accent_phrases?${query.toString()}`, {
    method: "POST",
  });

  await ensureVoicevoxOk(response, "VOICEVOX のアクセント解析に失敗しました。");

  return (await response.json()) as VoicevoxAccentPhrase[];
};

export const analyzeAccentLines = async (lines: string[]): Promise<VoicevoxAccentAnalysis> => {
  const phrasesByLine = await Promise.all(lines.map((line) => analyzeAccentLine(line)));

  return {
    hints: phrasesByLine.map((phrases, index) => buildAlignedAccentHint(lines[index], phrases)),
    phrasesByLine,
  };
};
