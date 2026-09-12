import type { LyricsResponse, SingingNote } from '../types';
import { buildSingingScore } from '../services/melodyService';
import { BPM, CHORDS, FPS, LEAD_FRAMES, LINE_FRAMES, MUSIC_VERSION, LOW_OCTAVE_VERSION, SONG_SECONDS, type Arrangement, type RoleId } from './shared';

export function melodyKey(line: number, cell: number, seed: number): number {
  let start = 0;
  const chord = CHORDS[line].find(c => { start += c.units; return cell * 8 < start; })!;
  if (line === 3 && cell >= 2) return 60;
  let hash = (seed ^ ((line * 4 + cell + 1) * 2654435761)) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return chord.keys[hash % 3] + 12;
}
const vowel = (mora: string) => {
  const last = mora.at(-1) ?? 'あ';
  if ('いきしちにひみりぎじぢびぴぃ'.includes(last)) return 'い';
  if ('うくすつぬふむゆるぐずづぶぷゅぅゔ'.includes(last)) return 'う';
  if ('えけせてねへめれげぜでべぺぇ'.includes(last)) return 'え';
  if ('おこそとのほもよろごぞどぼぽょぉ'.includes(last)) return 'お';
  if (last === 'ん') return 'ん';
  return 'あ';
};
/** Share pitch boundaries across different texts; subdivide held notes for their syllables. */
export function arrange(lyrics: LyricsResponse, role: RoleId, seed: number): Arrangement {
  if (lyrics.lines.length !== 4 || lyrics.singingKanaLines?.length !== 4) throw new Error('合奏には4行のかな歌詞が必要です。');
  const notes: SingingNote[] = [{ lyric: '', key: null, frame_length: LEAD_FRAMES }];
  for (let line = 0; line < 4; line++) {
    const source = buildSingingScore({ ...lyrics, singingKanaLines: [lyrics.singingKanaLines[line]] }, 'ensemble-tokenize', undefined, BPM);
    const moras = source.notes.filter(n => n.key !== null).map(n => n.lyric);
    if (moras.some(m => !/^[ぁ-ゖ]+$/u.test(m))) throw new Error('歌詞の読み方に歌えない文字が含まれています');
    if (!moras.length || moras.length > 28) throw new Error('歌詞を4行の短い言葉で作り直してください。');
    const cells = role === 'rhythm' ? 8 : 4;
    const unitsPerCell = 32 / cells;
    let previousMora = moras[0];
    for (let cell = 0; cell < cells; cell++) {
      const part = moras.slice(Math.ceil(cell * moras.length / cells), Math.ceil((cell + 1) * moras.length / cells));
      if (!part.length) part.push(vowel(previousMora));
      const unit = cell * unitsPerCell;
      let boundary = 0;
      const chord = CHORDS[line].find(c => { boundary += c.units; return unit < boundary; })!;
      const key = role === 'rhythm' ? (cell % 2 ? 60 : 55) : role === 'melody' || role === 'octave'
        ? melodyKey(line, cell, seed) + (role === 'octave' ? -12 : 0)
        : chord.keys[role === 'root' ? 0 : role === 'third' ? 1 : 2] + 12;
      part.forEach((lyric, i) => {
        const a = Math.round((unit + Math.floor(i * unitsPerCell / part.length)) * LINE_FRAMES / 32);
        const b = Math.round((unit + Math.floor((i + 1) * unitsPerCell / part.length)) * LINE_FRAMES / 32);
        notes.push({ lyric, key, frame_length: b - a });
        previousMora = lyric;
      });
    }
  }
  if (notes.some(n => n.frame_length <= 0)) throw new Error('音符の長さを作れませんでした。');
  if (notes.some(n => n.lyric && (!Number.isInteger(n.key) || n.key! < 0 || n.key! > 127))) throw new Error('歌声の音程を作れませんでした。');
  return { version: role === 'octave' ? LOW_OCTAVE_VERSION : MUSIC_VERSION, role, melodySeed: seed, score: { notes }, duration: SONG_SECONDS };
}
export const frameSeconds = (frames: number) => frames / FPS;
