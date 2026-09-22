import type { LyricsResponse } from "../types";
import { buildSingingScore, createSingingSeed, SingingCapacityError, SINGING_BPM } from "./melodyService";

/** Retry only score-capacity failures, before returning lyrics to the client. */
export const generateSingableLyrics = async <T>(
  generate: (feedback: string) => Promise<T>,
  getLyrics: (result: T) => LyricsResponse[],
  bpm = SINGING_BPM,
): Promise<T> => {
  let feedback = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await generate(feedback);
    try {
      for (const lyrics of getLyrics(result)) {
        // Explicit BPM keeps this shared code independent of Vite's browser env.
        buildSingingScore(lyrics, createSingingSeed(lyrics, 0), undefined, bpm);
      }
      return result;
    } catch (error) {
      if (!(error instanceof SingingCapacityError)) throw error;
      if (attempt === 2) {
        throw new SingingCapacityError("歌詞を短くして2回作り直しましたが、8拍に収まりませんでした。もう一度生成してください。");
      }
      feedback = `\n前回の歌唱用かな歌詞は楽譜の容量を超えました。全候補の各行を${attempt === 0 ? "12" : "8"}モーラ以内に短く作り直してください。` +
        `\n設定は${bpm} BPM、各行8拍（${(480 / bpm).toFixed(2)}秒）、最終行以外は末尾1拍が息継ぎです。` +
        "\n小さいゃゅょなどは前の文字と1モーラ、ーは1個ごとに1モーラです。語間の空白は必要最小限にしてください。" +
        "\n絵の題材、描く順番、行数、JSON形式を維持し、表示用linesとsingingKanaLinesの両方を同じ内容で短くしてください。";
    }
  }
  throw new Error("歌詞生成の試行回数が不正です。");
};
