import { LyricsResponse, SingingNote, SingingScore } from "../types";

const PHRASE_LENGTH = 330;
const LEADING_REST_LENGTH = 2;
const NOTE_POOL = [64, 65, 67];
const DEFAULT_NOTE_LENGTHS = [12, 18, 24, 30];
const PHRASE_END_NOTE_LENGTHS = [24, 30, 36, 42];
const FINAL_NOTE_LENGTHS = [36, 42, 48, 54];
const LONG_VOWEL_EXTENSION = 12;
const FINAL_CADENCES = [
  [65, 67, 60],
  [65, 64, 60],
];
const SMALL_KANA = new Set(["ゃ", "ゅ", "ょ", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "ゎ"]);
const SKIPPED_CHARACTERS = /[\s　、。，．！？!?,.「」『』（）()]/;

type MoraUnit = {
  lyric: string;
  extensionCount: number;
};

const normalizeKana = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/[ァ-ヶ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60))
    .replace(/ヴ/g, "ゔ");

const hashSeed = (seed: string) => {
  let hash = 2166136261;

  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
};

const createSeededRandom = (seed: string) => {
  let state = hashSeed(seed) || 1;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const pickRandom = <T>(items: T[], random: () => number) => items[Math.floor(random() * items.length)];

const splitIntoMoras = (line: string) => {
  const moras: MoraUnit[] = [];

  for (const rawCharacter of normalizeKana(line)) {
    if (SKIPPED_CHARACTERS.test(rawCharacter)) {
      continue;
    }

    if (rawCharacter === "ー") {
      if (moras.length > 0) {
        moras[moras.length - 1].extensionCount += 1;
      }
      continue;
    }

    if (SMALL_KANA.has(rawCharacter) && moras.length > 0) {
      moras[moras.length - 1].lyric += rawCharacter;
      continue;
    }

    moras.push({
      lyric: rawCharacter,
      extensionCount: 0,
    });
  }

  return moras;
};

const getMinimumLength = (mora: MoraUnit) => Math.min(...DEFAULT_NOTE_LENGTHS) + mora.extensionCount * LONG_VOWEL_EXTENSION;

const chooseLengthWithinBudget = (
  pool: number[],
  remainingBudget: number,
  minimumLengthsAfterCurrent: number,
  currentMinimumLength: number,
  random: () => number,
) => {
  const maxAllowedLength = remainingBudget - minimumLengthsAfterCurrent;
  const availableLengths = pool.filter((length) => length >= currentMinimumLength && length <= maxAllowedLength);

  if (availableLengths.length > 0) {
    return pickRandom(availableLengths, random);
  }

  return Math.max(currentMinimumLength, maxAllowedLength);
};

const applyFinalCadence = (notes: SingingNote[], random: () => number) => {
  if (notes.length === 0) {
    return;
  }

  if (notes.length >= 3) {
    const cadence = pickRandom(FINAL_CADENCES, random);
    notes[notes.length - 3].key = cadence[0];
    notes[notes.length - 2].key = cadence[1];
    notes[notes.length - 1].key = cadence[2];
    return;
  }

  if (notes.length === 2) {
    notes[0].key = pickRandom([65, 67], random);
    notes[1].key = 60;
    return;
  }

  notes[0].key = 60;
};

const buildPhraseForLine = (line: string, random: () => number, isFinalLine: boolean): SingingNote[] => {
  const moras = splitIntoMoras(line);

  if (moras.length === 0) {
    return [];
  }

  const totalMinimumLength = moras.reduce((sum, mora) => sum + getMinimumLength(mora), 0);

  if (totalMinimumLength > PHRASE_LENGTH) {
    throw new Error("歌詞の1行が長すぎて、固定フレーズ長に入りませんでした。");
  }

  let remainingBudget = PHRASE_LENGTH;
  const phraseNotes = moras.map((mora, index) => {
    const isPhraseEnd = index === moras.length - 1;
    const currentMinimumLength = getMinimumLength(mora);
    const minimumLengthsAfterCurrent = moras
      .slice(index + 1)
      .reduce((sum, nextMora) => sum + getMinimumLength(nextMora), 0);

    const basePool = isFinalLine && isPhraseEnd ? FINAL_NOTE_LENGTHS : isPhraseEnd ? PHRASE_END_NOTE_LENGTHS : DEFAULT_NOTE_LENGTHS;
    const extendedPool = Array.from(
      new Set(basePool.map((baseLength) => baseLength + mora.extensionCount * LONG_VOWEL_EXTENSION)),
    ).sort((left, right) => left - right);

    const noteLength = chooseLengthWithinBudget(
      extendedPool,
      remainingBudget,
      minimumLengthsAfterCurrent,
      currentMinimumLength,
      random,
    );

    remainingBudget -= noteLength;

    return {
      lyric: mora.lyric,
      key: pickRandom(NOTE_POOL, random),
      frame_length: noteLength,
    };
  });

  if (isFinalLine) {
    applyFinalCadence(phraseNotes, random);
  }

  if (remainingBudget > 0) {
    phraseNotes.push({
      lyric: "",
      key: null,
      frame_length: remainingBudget,
    });
  }

  return phraseNotes;
};

export const createSingingSeed = (lyrics: LyricsResponse, variant = 0) =>
  `${lyrics.title}::${lyrics.identifiedObject}::${lyrics.lines.join("|")}::${variant}`;

export const buildSingingScore = (lyrics: LyricsResponse, seed: string): SingingScore => {
  const sourceLines = lyrics.singingKanaLines?.filter((line) => line.trim().length > 0) ?? [];

  if (sourceLines.length === 0) {
    throw new Error("歌声合成用のかな歌詞がありません。歌詞を再生成してください。");
  }

  const random = createSeededRandom(seed);
  const notes: SingingNote[] = [
    {
      lyric: "",
      key: null,
      frame_length: LEADING_REST_LENGTH,
    },
  ];

  sourceLines.forEach((line, index) => {
    const phraseNotes = buildPhraseForLine(line, random, index === sourceLines.length - 1);
    notes.push(...phraseNotes);
  });

  if (notes.length === 0) {
    throw new Error("歌声合成に使える文字が見つかりませんでした。");
  }

  return { notes };
};
