import { GoogleGenAI, Type } from '@google/genai';
import type { LyricsResponse } from '../../types';

export function validSingingKana(lines: unknown): lines is string[] {
  return Array.isArray(lines) && lines.length === 4 && lines.every(line => typeof line === 'string' && /^[ぁ-ゖー\s、。！？!?]+$/u.test(line) && line.replace(/[\s、。！？!?]/g, '').length > 0 && line.replace(/\s/g, '').length <= 28);
}
export async function prepareLyrics(lyrics: LyricsResponse, env: { GEMINI_API_KEY?: string; LYRICS_BASE_MODEL?: string }): Promise<LyricsResponse> {
  if (validSingingKana(lyrics.singingKanaLines)) return lyrics;
  // Keep the visible lyrics and drawing unchanged. Repair only invalid pronunciation data.
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: env.LYRICS_BASE_MODEL || 'gemini-3.5-flash',
    contents: [{ parts: [{ text: '次の4行の日本語歌詞を、VOICEVOX歌唱用のひらがなの発音にしてください。歌詞の意味や順番は変更しません。英字・漢字・数字・注釈は絶対に含めず、ひらがなと空白だけ。助詞の「は」は「わ」、「へ」は「え」、「を」は「お」。長音は母音で表現。各行28文字以内。入力: ' + JSON.stringify(lyrics.lines) }] }],
    config: { responseMimeType: 'application/json', responseSchema: { type: Type.OBJECT, properties: { lines: { type: Type.ARRAY, items: { type: Type.STRING }, minItems: 4, maxItems: 4 } }, required: ['lines'] } },
  });
  const result = JSON.parse(response.text || '{}');
  if (!validSingingKana(result.lines)) throw new Error('歌詞の読み方を整えられませんでした。もう一度試してください。');
  return { ...lyrics, singingKanaLines: result.lines };
}
