import { LyricsResponse, SingingNote, SingingScore } from "../types";
import { SCORE_FRAMES_PER_SECOND } from "./silentPlaybackService";

export const SINGING_BPM = 125;
const PHRASE_BEATS = 8;
const UNITS_PER_BEAT = 4;
const PHRASE_UNITS = PHRASE_BEATS * UNITS_PER_BEAT;
const BREATH_REST_UNITS = UNITS_PER_BEAT;
const WORD_BREAK_REST_UNITS = 2;
const LEADING_REST_LENGTH = 2;
const FINAL_REST_LENGTH = 2;
const NOTE_POOL = [64, 65, 67];
const MIN_NOTE_UNITS = 1;
const GROUP_END_WEIGHT_BONUS = 0.65;
const FINAL_GROUP_END_WEIGHT_BONUS = 0.35;
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

// Durations stay on the sixteenth-note grid until the VOICEVOX boundary.
type RhythmNote = Omit<SingingNote, "frame_length"> & { sixteenths: number };

export const resolveSingingBpm = (value: string | number | undefined): number => {
  const bpm = value === undefined || (typeof value === "string" && value.trim() === "") ? SINGING_BPM : Number(value);
  if (!Number.isFinite(bpm) || bpm < 60 || bpm > 180) {
    throw new Error("歌声のBPMは60から180の数値で指定してください（VITE_SINGING_BPM）。");
  }
  return bpm;
};

export const rhythmNotesToSingingNotes = (notes: RhythmNote[], bpm = SINGING_BPM): SingingNote[] => {
  const phraseFrames = Math.round((SCORE_FRAMES_PER_SECOND * 60 * PHRASE_BEATS) / resolveSingingBpm(bpm));
  let elapsedUnits = 0;
  let previousFrame = 0;
  return notes.map((note) => {
    if (!Number.isSafeInteger(note.sixteenths) || note.sixteenths <= 0 || elapsedUnits + note.sixteenths > PHRASE_UNITS) {
      throw new Error("音符の長さを整数フレームに変換できませんでした。");
    }
    elapsedUnits += note.sixteenths;
    // Round absolute positions within a fixed-length phrase, never individual durations.
    const endFrame = Math.round((elapsedUnits * phraseFrames) / PHRASE_UNITS);
    const frameLength = endFrame - previousFrame;
    previousFrame = endFrame;
    return { lyric: note.lyric, key: note.key, frame_length: frameLength };
  });
};

export type MelodyAccentLevel = "low" | "mid" | "high" | "neutral";

export type MelodyAccentLineHint = {
  levels: MelodyAccentLevel[];
  /** Exclusive mora offsets, including long-vowel extensions, without rests. */
  phraseEnds?: number[];
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

// Share exactly the score's normalization and mora boundaries with talk analysis.
export const getSingingMoras = (line: string): string[] => splitIntoPhraseUnits(line)
  .flatMap((unit) => unit.type === "rest" ? [] : [unit.lyric, ...Array<string>(unit.extensionCount).fill("ー")]);

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
  // A long-vowel mark occupies a full mora, held on the preceding pitch.
  let weight = 1 + mora.extensionCount;

  if (isGroupEnd) {
    weight += GROUP_END_WEIGHT_BONUS;
  }

  if (isFinalPhraseEnd && isGroupEnd) {
    weight += FINAL_GROUP_END_WEIGHT_BONUS;
  }

  return weight;
};

const allocateRhythmicPhraseLengths = (
  { groups, units }: ParsedLine,
  isFinalLine: boolean,
  phraseLength: number,
  beatTemplate: number[],
) => {
  const restCount = units.filter((unit) => unit.type === "rest").length;
  const moraCount = groups.reduce((sum, group) =>
    sum + group.moras.reduce((count, mora) => count + 1 + mora.extensionCount, 0), 0);
  if (moraCount * MIN_NOTE_UNITS + restCount > phraseLength) {
    throw new Error("歌詞の1行が長すぎて、固定フレーズ長に入りませんでした。");
  }

  const phraseNoteLength = phraseLength - restCount * WORD_BREAK_REST_UNITS;
  const totalBeats = beatTemplate.reduce((sum, beats) => sum + beats, 0);
  const noteTargets = groups.flatMap((group, groupIndex) => {
    const weights = group.moras.map((mora, moraIndex) =>
      getMoraRhythmWeight(
        mora,
        moraIndex,
        group.moras.length,
        isFinalLine && groupIndex === groups.length - 1 && moraIndex === group.moras.length - 1,
      ),
    );
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const groupTarget = phraseNoteLength * beatTemplate[groupIndex] / totalBeats;
    return weights.map((weight) => groupTarget * weight / totalWeight);
  });
  let moraIndex = 0;
  const targets = units.map((unit) => unit.type === "rest" ? WORD_BREAK_REST_UNITS : noteTargets[moraIndex++]);
  let targetEnd = 0;
  const targetEnds = targets.map((length) => (targetEnd += length));

  const allocate = (minimumMoraLength: number) => {
    type Allocation = { cost: number; lengths: number[] };
    let states = new Map<number, Allocation>([[0, { cost: 0, lengths: [] }]]);
    units.forEach((unit, index) => {
      const nextStates = new Map<number, Allocation>();
      const span = unit.type === "mora" ? 1 + unit.extensionCount : 1;
      const minimum = unit.type === "rest" ? MIN_NOTE_UNITS : span * minimumMoraLength;

      for (const [start, allocation] of states) {
        const beatOffset = start % UNITS_PER_BEAT;
        for (let length = minimum; start + length <= phraseLength; length += 1) {
          const end = start + length;
          // An off-beat onset must finish within this beat. It cannot carry
          // a sixteenth-note displacement into the following beat.
          if (beatOffset !== 0 && length > UNITS_PER_BEAT - beatOffset) break;
          if (unit.type === "rest") {
            // Word breaks finish on a beat or an eighth, never an odd sixteenth.
            if (length > UNITS_PER_BEAT || end % WORD_BREAK_REST_UNITS !== 0) continue;
          } else if (length > UNITS_PER_BEAT && length % UNITS_PER_BEAT !== 0) {
            // Longer holds start and finish on beats (ties are represented by
            // one sustained note, including any long-vowel marks).
            continue;
          }

          const deviation = length - targets[index];
          // Spread subdivisions through the phrase instead of packing all
          // short notes at one end when several allocations have equal cost.
          const positionDeviation = end - targetEnds[index];
          const shortNotePenalty = unit.type === "mora" && length < span * 2 ? 4 : 0;
          const wordBreakPenalty = unit.type === "rest" && end % UNITS_PER_BEAT !== 0 ? 1 : 0;
          const cost = allocation.cost + deviation * deviation / span + positionDeviation * positionDeviation / 2
            + shortNotePenalty + wordBreakPenalty;
          const existing = nextStates.get(end);
          if (!existing || cost < existing.cost) {
            nextStates.set(end, { cost, lengths: [...allocation.lengths, length] });
          }
        }
      }
      states = nextStates;
    });
    return states.get(phraseLength)?.lengths;
  };

  // Prefer eighths or longer for every mora, including each long-vowel mark.
  // Dense lines may use sixteenths, but the beat constraints never relax.
  const lengths = (moraCount * 2 + restCount * WORD_BREAK_REST_UNITS <= phraseLength ? allocate(2) : undefined)
    ?? allocate(MIN_NOTE_UNITS);
  if (!lengths) {
    throw new Error("歌詞の1行が長すぎて、拍に沿った固定フレーズ長に入りませんでした。");
  }
  return lengths;
};

/** Refine only an affected phrase; its endpoints and all explicit rests stay fixed. */
const refinePhraseLengths = (units: PhraseUnit[], original: number[], hint?: MelodyAccentLineHint): number[] => {
  if (!hint?.phraseEnds?.length) return original;
  const totalMoras = units.reduce((sum, unit) => sum + (unit.type === "mora" ? 1 + unit.extensionCount : 0), 0);
  const ends = hint.phraseEnds;
  if (ends.at(-1) !== totalMoras || ends.some((end, index) =>
    !Number.isSafeInteger(end) || end <= (ends[index - 1] ?? 0))) return original;
  const boundaries = new Set(ends);
  const result = [...original];
  const minimumMora = units.every((unit, index) => unit.type === "rest"
    || original[index] >= 2 * (1 + unit.extensionCount)) ? 2 : 1;
  let moraPosition = 0;
  let position = 0;
  let segmentStart = 0;
  let segmentPosition = 0;

  const refine = (end: number, endPosition: number) => {
    if (end - segmentStart < 2) return;
    const limit = (index: number) => {
      const unit = units[index] as MoraUnit;
      return Math.max(UNITS_PER_BEAT, 2 * (1 + unit.extensionCount));
    };
    const originalExcess = original.slice(segmentStart, end - 1)
      .reduce((sum, length, offset) => sum + Math.max(0, length - limit(segmentStart + offset)), 0);
    if (originalExcess === 0) return;
    type Candidate = { excess: number; changes: number; deviation: number; lengths: number[] };
    const better = (a: Candidate, b: Candidate) => a.excess < b.excess
      || (a.excess === b.excess && (a.changes < b.changes
        || (a.changes === b.changes && a.deviation < b.deviation)));
    let states = new Map<number, Candidate>([[segmentPosition, { excess: 0, changes: 0, deviation: 0, lengths: [] }]]);
    for (let index = segmentStart; index < end; index += 1) {
      const next = new Map<number, Candidate>();
      const unit = units[index] as MoraUnit;
      for (const [start, candidate] of states) {
        for (let length = minimumMora * (1 + unit.extensionCount);
          start + length <= endPosition && length <= original[index] + UNITS_PER_BEAT; length += 1) {
          const offset = start % UNITS_PER_BEAT;
          if (offset !== 0 && length > UNITS_PER_BEAT - offset) break;
          if (length > UNITS_PER_BEAT && length % UNITS_PER_BEAT !== 0) continue;
          const excess = index === end - 1 ? 0 : Math.max(0, length - limit(index));
          // Never introduce a new internal hold to fix another one.
          if (excess > Math.max(0, original[index] - limit(index))) continue;
          const value = {
            excess: candidate.excess + excess,
            changes: candidate.changes + Number(length !== original[index]),
            deviation: candidate.deviation + (length - original[index]) ** 2,
            lengths: [...candidate.lengths, length],
          };
          const existing = next.get(start + length);
          if (!existing || better(value, existing)) next.set(start + length, value);
        }
      }
      states = next;
    }
    const best = states.get(endPosition);
    if (best && best.excess < originalExcess) result.splice(segmentStart, end - segmentStart, ...best.lengths);
  };

  units.forEach((unit, index) => {
    if (unit.type === "rest") {
      refine(index, position);
      position += original[index];
      segmentStart = index + 1;
      segmentPosition = position;
      return;
    }
    moraPosition += 1 + unit.extensionCount;
    position += original[index];
    // A boundary inside a sustained long vowel is intentionally ignored.
    if (boundaries.has(moraPosition)) {
      refine(index + 1, position);
      segmentStart = index + 1;
      segmentPosition = position;
    }
  });
  return result;
};

// Run after phrase refinement. Expand the editable suffix only when necessary.
const finalizeCadenceLengths = (units: PhraseUnit[], original: number[]): number[] => {
  const pitched = units.flatMap((unit, index) => unit.type === "mora" ? [index] : []);
  if (pitched.length < 2) return original;
  const last = pitched.at(-1)!;
  const previous = pitched.at(-2)!;
  const starts = original.map((_, index) => original.slice(0, index).reduce((sum, value) => sum + value, 0));
  if (original[last] >= original[previous]) return original;

  type Candidate = { position: number; previousLength: number; changes: number; cost: number; lengths: number[] };
  const preferredMinimum = units.every((unit, index) => unit.type === "rest"
    || original[index] >= 2 * (1 + unit.extensionCount)) ? 2 : 1;
  for (let minimumMora = preferredMinimum; minimumMora >= 1; minimumMora -= 1) {
    for (let first = previous; first >= 0; first -= 1) {
      let states: Candidate[] = [{ position: starts[first], previousLength: 0, changes: 0, cost: 0, lengths: [] }];
      for (let index = first; index <= last; index += 1) {
        const next = new Map<string, Candidate>();
        const unit = units[index];
        const minimum = unit.type === "rest" ? original[index] : minimumMora * (1 + unit.extensionCount);
        for (const state of states) {
          for (let length = minimum; state.position + length <= PHRASE_UNITS; length += 1) {
            if (unit.type === "rest" && length !== original[index]) break;
            const offset = state.position % UNITS_PER_BEAT;
            if (offset !== 0 && length > UNITS_PER_BEAT - offset) break;
            if (length > UNITS_PER_BEAT && length % UNITS_PER_BEAT !== 0) continue;
            const end = state.position + length;
            if (unit.type === "rest" && end % 2 !== 0) continue;
            if (index === last && (end !== PHRASE_UNITS || length < state.previousLength)) continue;
            const candidate: Candidate = {
              position: end,
              previousLength: unit.type === "rest" ? state.previousLength : length,
              changes: state.changes + Number(length !== original[index]),
              cost: state.cost + (length - original[index]) ** 2,
              lengths: [...state.lengths, length],
            };
            const key = `${end}:${candidate.previousLength}`;
            const existing = next.get(key);
            if (!existing || candidate.changes < existing.changes
              || (candidate.changes === existing.changes && candidate.cost < existing.cost)) next.set(key, candidate);
          }
        }
        states = [...next.values()];
      }
      const best = states.filter(state => state.position === PHRASE_UNITS)
        .sort((a, b) => a.changes - b.changes || a.cost - b.cost)[0];
      if (best) return [...original.slice(0, first), ...best.lengths];
    }
  }
  throw new Error("最後のドを直前の音以上の長さにして8拍に収められません。最終行の歌詞を短くしてください。");
};

const validatePhraseLengths = (units: PhraseUnit[], lengths: number[], expected: number) => {
  let position = 0;
  lengths.forEach((length, index) => {
    const unit = units[index];
    const minimum = unit.type === "mora" ? 1 + unit.extensionCount : 1;
    const offset = position % UNITS_PER_BEAT;
    if (!Number.isSafeInteger(length) || length < minimum
      || (offset !== 0 && length > UNITS_PER_BEAT - offset)
      || (length > UNITS_PER_BEAT && length % UNITS_PER_BEAT !== 0)
      || (unit.type === "rest" && (length > UNITS_PER_BEAT || (position + length) % 2 !== 0))) {
      throw new Error("歌詞の区切り補正後の音価が拍の条件を満たしていません。");
    }
    position += length;
  });
  if (position !== expected) throw new Error("歌詞の区切り補正後の行長が一致しません。");
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

const applyFinalCadence = (notes: RhythmNote[], previousKey: number | null, random: () => number) => {
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

const getLastPitchedKey = (notes: RhythmNote[]) => {
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
): RhythmNote[] => {
  const phraseUnits = parsedLine.units;
  const moras = phraseUnits.filter((unit): unit is MoraUnit => unit.type === "mora");

  if (moras.length === 0) {
    return [];
  }

  const breathRestLength = isFinalLine ? 0 : BREATH_REST_UNITS;
  const phraseLength = PHRASE_UNITS - breathRestLength;
  const beatTemplate =
    rhythmTemplates.get(parsedLine.groups.length) ?? createFallbackBeatTemplate(parsedLine.groups.length);
  const originalLengths = allocateRhythmicPhraseLengths(parsedLine, isFinalLine, phraseLength, beatTemplate);
  const refinedLengths = refinePhraseLengths(phraseUnits, originalLengths, accentLineHint);
  const noteLengths = isFinalLine ? finalizeCadenceLengths(phraseUnits, refinedLengths) : refinedLengths;
  validatePhraseLengths(phraseUnits, noteLengths, phraseLength);
  let currentKey = previousKey;
  let moraIndex = 0;
  const phraseNotes = phraseUnits.map((unit, unitIndex) => {
    if (unit.type === "rest") {
      return {
        lyric: "",
        key: null,
        sixteenths: noteLengths[unitIndex],
      };
    }

    const accentLevel = accentLineHint?.levels[moraIndex];
    const key = chooseStepwisePitch(currentKey, random, accentLevel);
    const sixteenths = noteLengths[unitIndex];
    currentKey = key;
    moraIndex += 1 + unit.extensionCount;

    return {
      lyric: unit.lyric,
      key,
      sixteenths,
    };
  });

  if (isFinalLine) {
    applyFinalCadence(phraseNotes, previousKey, random);
  }

  if (breathRestLength > 0) {
    phraseNotes.push({
      lyric: "",
      key: null,
      sixteenths: breathRestLength,
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
  bpm = resolveSingingBpm(import.meta.env.VITE_SINGING_BPM),
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
    notes.push(...rhythmNotesToSingingNotes(phraseNotes, bpm));
    previousKey = getLastPitchedKey(phraseNotes) ?? previousKey;
  });

  if (notes.length <= 1) {
    throw new Error("歌声合成に使える文字が見つかりませんでした。");
  }

  notes.push({
    lyric: "",
    key: null,
    frame_length: FINAL_REST_LENGTH,
  });

  return { notes };
};
