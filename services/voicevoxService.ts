import { SingingScore } from "../types";
import { ensureVoicevoxOk, fetchVoicevox } from "./voicevoxHttp";

const SING_QUERY_SPEAKER = 6000;
const FRAME_SYNTHESIS_SPEAKER = 3003;

export type VoicevoxProgressStage =
  | "query_requested"
  | "query_ready"
  | "synthesis_requested"
  | "synthesis_ready";

export const synthesizeSingingVoice = async (
  score: SingingScore,
  onProgress?: (stage: VoicevoxProgressStage) => void,
): Promise<Blob> => {
  onProgress?.("query_requested");
  const queryResponse = await fetchVoicevox(`/sing_frame_audio_query?speaker=${SING_QUERY_SPEAKER}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(score),
  }, {
    timeoutMs: 60_000,
    failureMessage: "VOICEVOX Engine に歌唱クエリを送信できませんでした。Engine の起動、CORS 許可、ブラウザのローカルネットワークアクセス許可を確認してください。",
  });

  await ensureVoicevoxOk(queryResponse, "VOICEVOX の歌唱クエリ生成に失敗しました。");
  onProgress?.("query_ready");

  const queryPayload = await queryResponse.json();

  onProgress?.("synthesis_requested");
  const synthesisResponse = await fetchVoicevox(`/frame_synthesis?speaker=${FRAME_SYNTHESIS_SPEAKER}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(queryPayload),
  }, {
    timeoutMs: 120_000,
    failureMessage: "VOICEVOX Engine に歌声合成を依頼できませんでした。Engine の起動、CORS 許可、ブラウザのローカルネットワークアクセス許可を確認してください。",
  });

  await ensureVoicevoxOk(synthesisResponse, "VOICEVOX の歌声合成に失敗しました。");
  onProgress?.("synthesis_ready");

  const audioBlob = await synthesisResponse.blob();
  const header = new Uint8Array(await audioBlob.slice(0, 12).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...header.slice(start, end));
  if (header.length < 12 || ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WAVE") {
    throw new Error("VOICEVOXからWAV形式の歌声を受け取れませんでした。");
  }

  return audioBlob;
};
