import { LyricsResponse, SingingNote, SingingScore } from "../types";

const PHRASE_LENGTH = 330;
const PHRASE_BEATS = 8;
const BREATH_REST_LENGTH = Math.round(PHRASE_LENGTH / PHRASE_BEATS);
const WORD_BREAK_REST_LENGTH = Math.round(BREATH_REST_LENGTH / 4);
const LEADING_REST_LENGTH = 2;
const NOTE_POOL = [64, 65, 67];
const MIN_NOTE_LENGTH = 8;
const LONG_VOWEL_WEIGHT_BONUS = 0.4;
const GROUP_END_WEIGHT_BONUS = 0.65;
const FINAL_GROUP_END_WEIGHT_BONUS = 0.35;
const REPEATED_SHORT_WEIGHT = 0.8;
const REPEATED_LONG_WEIGHT = 1.25;
const FINAL_CADENCES = [
  [65, 67, 60],
  [65, 64, 60],
];
const BEAT_TEMPLATES_BY_GROUP_COUNT: Record<number, number[][]> = {
  1: [[8]],
  2: [[4, 4]],
  3: [
    [2, 2, 4],
    [2, 3, 3],
  ],
  4: [[2, 2, 2, 2]],
  5: [[1.5, 1.5, 1.5, 1.5, 2]],
  6: [[1, 1, 1.5, 1.5, 1.5, 1.5]],
};
const SMALL_KANA = new Set(["ゃ", "ゅ", "ょ", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "ゎ"]);
const SKIPPED_CHARACTERS = /[\s　、。，．！？!?,.「」『』（）()]/;

type MoraUnit = {
  type: "mora";
  lyric: string;
  extensionCount: number;
};

type RestUnit = {
  type: "rest";
};

type PhraseUnit = MoraUnit | RestUnit;

type PhraseGroup = {
  moras: MoraUnit[];
};

type ParsedLine = {
  groups: PhraseGroup[];
  units: PhraseUnit[];
};

type RhythmTemplateMap = Map<number, number[]>;

export type MelodyAccentLevel = "low" | "mid" | "high" | "neutral";

export type MelodyAccentLineHint = {
  levels: MelodyAccentLevel[];
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

const pickWeighted = <T>(items: T[], getWeight: (item: T) => number, random: () => number) => {
  const weights = items.map((item) => Math.max(0.001, getWeight(item)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = random() * totalWeight;

  for (let index = 0; index < items.length; index += 1) {
    cursor -= weights[index];

    if (cursor <= 0) {
      return items[index];
    }
  }

  return items[items.length - 1];
};

const splitIntoPhraseUnits = (line: string) => {
  const units: PhraseUnit[] = [];

  for (const rawCharacter of normalizeKana(line)) {
    if (rawCharacter === " ") {
      if (units.length > 0 && units[units.length - 1].type !== "rest") {
        units.push({ type: "rest" });
      }
      continue;
    }

    if (SKIPPED_CHARACTERS.test(rawCharacter)) {
      continue;
    }

    if (rawCharacter === "ー") {
      const previousUnit = units[units.length - 1];

      if (previousUnit?.type === "mora") {
        previousUnit.extensionCount += 1;
      }
      continue;
    }

    const previousUnit = units[units.length - 1];

    if (SMALL_KANA.has(rawCharacter) && previousUnit?.type === "mora") {
      previousUnit.lyric += rawCharacter;
      continue;
    }

    units.push({
      type: "mora",
      lyric: rawCharacter,
      extensionCount: 0,
    });
  }

  if (units[units.length - 1]?.type === "rest") {
    units.pop();
  }

  return units;
};

const groupPhraseUnits = (units: PhraseUnit[]) => {
  const groups: PhraseGroup[] = [];
  let currentGroup: MoraUnit[] = [];

  for (const unit of units) {
    if (unit.type === "rest") {
      if (currentGroup.length > 0) {
        groups.push({ moras: currentGroup });
        currentGroup = [];
      }
      continue;
    }

    currentGroup.push(unit);
  }

  if (currentGroup.length > 0) {
    groups.push({ moras: currentGroup });
  }

  return groups;
};

const parseLine = (line: string): ParsedLine => {
  const units = splitIntoPhraseUnits(line);

  return {
    groups: groupPhraseUnits(units),
    units,
  };
};

const allocateWeightedLengths = (totalLength: number, minimumLengths: number[], weights: number[]) => {
  const minimumTotalLength = minimumLengths.reduce((sum, length) => sum + length, 0);

  if (minimumTotalLength > totalLength) {
    throw new Error("歌詞の1行が長すぎて、固定フレーズ長に入りませんでした。");
  }

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const extraBudget = totalLength - minimumTotalLength;
  const rawExtras = weights.map((weight) => (extraBudget * weight) / totalWeight);
  const lengths = rawExtras.map((extraLength, index) => minimumLengths[index] + Math.floor(extraLength));
  let remainingFrames = totalLength - lengths.reduce((sum, length) => sum + length, 0);

  rawExtras
    .map((extraLength, index) => ({
      index,
      fraction: extraLength - Math.floor(extraLength),
    }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)
    .forEach(({ index }) => {
      if (remainingFrames <= 0) {
        return;
      }

      lengths[index] += 1;
      remainingFrames -= 1;
    });

  return lengths;
};

const createFallbackBeatTemplate = (groupCount: number) => Array.from({ length: groupCount }, () => PHRASE_BEATS / groupCount);

const selectRhythmTemplates = (lines: ParsedLine[], random: () => number): RhythmTemplateMap => {
  const templates: RhythmTemplateMap = new Map();
  const groupCounts = Array.from(new Set(lines.map((line) => line.groups.length).filter((groupCount) => groupCount > 0)));

  groupCounts.forEach((groupCount) => {
    const candidates = BEAT_TEMPLATES_BY_GROUP_COUNT[groupCount] ?? [createFallbackBeatTemplate(groupCount)];
    templates.set(groupCount, pickRandom(candidates, random));
  });

  return templates;
};

const getMoraRhythmWeight = (mora: MoraUnit, index: number, moraCount: number, isFinalPhraseEnd: boolean) => {
  const isGroupEnd = index === moraCount - 1;
  let weight = index % 3 === 2 ? REPEATED_LONG_WEIGHT : REPEATED_SHORT_WEIGHT;

  if (isGroupEnd) {
    weight += GROUP_END_WEIGHT_BONUS;
  }

  if (isFinalPhraseEnd && isGroupEnd) {
    weight += FINAL_GROUP_END_WEIGHT_BONUS;
  }

  weight += mora.extensionCount * LONG_VOWEL_WEIGHT_BONUS;

  return weight;
};

const allocateRhythmicPhraseLengths = (
  groups: PhraseGroup[],
  isFinalLine: boolean,
  phraseNoteLength: number,
  beatTemplate: number[],
) => {
  const groupMinimumLengths = groups.map((group) => group.moras.length * MIN_NOTE_LENGTH);
  const groupLengths = allocateWeightedLengths(phraseNoteLength, groupMinimumLengths, beatTemplate);

  return groups.flatMap((group, groupIndex) => {
    const minimumLengths = group.moras.map(() => MIN_NOTE_LENGTH);
    const weights = group.moras.map((mora, moraIndex) =>
      getMoraRhythmWeight(
        mora,
        moraIndex,
        group.moras.length,
        isFinalLine && groupIndex === groups.length - 1 && moraIndex === group.moras.length - 1,
      ),
    );

    return allocateWeightedLengths(groupLengths[groupIndex], minimumLengths, weights);
  });
};

const getAccentTargetKey = (accentLevel: MelodyAccentLevel | undefined) => {
  if (accentLevel === "low") {
    return 64;
  }

  if (accentLevel === "mid") {
    return 65;
  }

  if (accentLevel === "high") {
    return 67;
  }

  return null;
};

const getPitchCandidateWeight = (candidateKey: number, previousKey: number | null, accentLevel: MelodyAccentLevel | undefined) => {
  const movementScore = previousKey === null ? 3 : 5 - Math.abs(candidateKey - previousKey);
  const accentTargetKey = getAccentTargetKey(accentLevel);
  const accentScore = accentTargetKey === null ? 0 : 4 - Math.abs(candidateKey - accentTargetKey) * 1.8;
  const neutralPenalty = accentLevel === "neutral" || accentLevel === undefined ? 0 : 0.4;

  return movementScore + accentScore - neutralPenalty;
};

const chooseStepwisePitch = (
  previousKey: number | null,
  random: () => number,
  accentLevel: MelodyAccentLevel | undefined,
) =>
  pickWeighted(
    NOTE_POOL,
    (candidateKey) => getPitchCandidateWeight(candidateKey, previousKey, accentLevel),
    random,
  );

const getCadenceMovementScore = (cadence: number[], previousKey: number | null) => {
  let movementScore = 0;
  let currentKey = previousKey;

  for (const key of cadence) {
    if (currentKey !== null) {
      movementScore += Math.abs(key - currentKey);
    }

    currentKey = key;
  }

  return movementScore;
};

const pickSmoothestCadence = (cadences: number[][], previousKey: number | null, random: () => number) => {
  const scoredCadences = cadences.map((cadence) => ({
    cadence,
    score: getCadenceMovementScore(cadence, previousKey),
  }));
  const bestScore = Math.min(...scoredCadences.map(({ score }) => score));
  const bestCadences = scoredCadences.filter(({ score }) => score === bestScore).map(({ cadence }) => cadence);

  return pickRandom(bestCadences, random);
};

const applyFinalCadence = (notes: SingingNote[], previousKey: number | null, random: () => number) => {
  const pitchedIndexes = notes
    .map((note, index) => (note.key === null ? null : index))
    .filter((index): index is number => index !== null);

  if (pitchedIndexes.length === 0) {
    return;
  }

  if (pitchedIndexes.length >= 3) {
    const cadenceIndexes = pitchedIndexes.slice(-3);
    const anchorIndex = pitchedIndexes[pitchedIndexes.length - 4];
    const cadenceAnchor = anchorIndex === undefined ? previousKey : notes[anchorIndex].key;
    const cadence = pickSmoothestCadence(FINAL_CADENCES, cadenceAnchor, random);
    notes[cadenceIndexes[0]].key = cadence[0];
    notes[cadenceIndexes[1]].key = cadence[1];
    notes[cadenceIndexes[2]].key = cadence[2];
    return;
  }

  if (pitchedIndexes.length === 2) {
    const cadence = pickSmoothestCadence(
      NOTE_POOL.map((note) => [note, 60]),
      previousKey,
      random,
    );
    notes[pitchedIndexes[0]].key = cadence[0];
    notes[pitchedIndexes[1]].key = 60;
    return;
  }

  notes[pitchedIndexes[0]].key = 60;
};

const getLastPitchedKey = (notes: SingingNote[]) => {
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    if (notes[index].key !== null) {
      return notes[index].key;
    }
  }

  return null;
};

const buildPhraseForLine = (
  parsedLine: ParsedLine,
  random: () => number,
  isFinalLine: boolean,
  previousKey: number | null,
  rhythmTemplates: RhythmTemplateMap,
  accentLineHint: MelodyAccentLineHint | undefined,
): SingingNote[] => {
  const phraseUnits = parsedLine.units;
  const moras = phraseUnits.filter((unit): unit is MoraUnit => unit.type === "mora");

  if (moras.length === 0) {
    return [];
  }

  const breathRestLength = isFinalLine ? 0 : BREATH_REST_LENGTH;
  const wordBreakRestCount = phraseUnits.filter((unit) => unit.type === "rest").length;
  const wordBreakRestTotalLength = wordBreakRestCount * WORD_BREAK_REST_LENGTH;
  const phraseNoteLength = PHRASE_LENGTH - breathRestLength - wordBreakRestTotalLength;
  const beatTemplate =
    rhythmTemplates.get(parsedLine.groups.length) ?? createFallbackBeatTemplate(parsedLine.groups.length);
  const noteLengths = allocateRhythmicPhraseLengths(parsedLine.groups, isFinalLine, phraseNoteLength, beatTemplate);
  let currentKey = previousKey;
  let moraIndex = 0;
  const phraseNotes = phraseUnits.map((unit) => {
    if (unit.type === "rest") {
      return {
        lyric: "",
        key: null,
        frame_length: WORD_BREAK_REST_LENGTH,
      };
    }

    const accentLevel = accentLineHint?.levels[moraIndex];
    const key = chooseStepwisePitch(currentKey, random, accentLevel);
    const frameLength = noteLengths[moraIndex];
    currentKey = key;
    moraIndex += 1;

    return {
      lyric: unit.lyric,
      key,
      frame_length: frameLength,
    };
  });

  if (isFinalLine) {
    applyFinalCadence(phraseNotes, previousKey, random);
  }

  if (breathRestLength > 0) {
    phraseNotes.push({
      lyric: "",
      key: null,
      frame_length: breathRestLength,
    });
  }

  return phraseNotes;
};

export const createSingingSeed = (lyrics: LyricsResponse, variant = 0) =>
  `${lyrics.title}::${lyrics.identifiedObject}::${lyrics.lines.join("|")}::${variant}`;

export const buildSingingScore = (
  lyrics: LyricsResponse,
  seed: string,
  accentLineHints?: MelodyAccentLineHint[],
): SingingScore => {
  const sourceLines = lyrics.singingKanaLines?.filter((line) => line.trim().length > 0) ?? [];

  if (sourceLines.length === 0) {
    throw new Error("歌声合成用のかな歌詞がありません。歌詞を再生成してください。");
  }

  const random = createSeededRandom(seed);
  const parsedLines = sourceLines.map(parseLine);
  const rhythmTemplates = selectRhythmTemplates(parsedLines, random);
  const notes: SingingNote[] = [
    {
      lyric: "",
      key: null,
      frame_length: LEADING_REST_LENGTH,
    },
  ];
  let previousKey: number | null = null;

  parsedLines.forEach((parsedLine, index) => {
    const phraseNotes = buildPhraseForLine(
      parsedLine,
      random,
      index === parsedLines.length - 1,
      previousKey,
      rhythmTemplates,
      accentLineHints?.[index],
    );
    notes.push(...phraseNotes);
    previousKey = getLastPitchedKey(phraseNotes) ?? previousKey;
  });

  if (notes.length <= 1) {
    throw new Error("歌声合成に使える文字が見つかりませんでした。");
  }

  return { notes };
};
