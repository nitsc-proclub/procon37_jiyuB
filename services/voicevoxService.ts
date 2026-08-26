import { SingingScore } from "../types";
import { ensureVoicevoxOk, fetchVoicevox, isDevelopmentVoicevox } from "./voicevoxHttp";

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
  voiceGrant?: string,
): Promise<Blob> => {
  onProgress?.("query_requested");
  let synthesisResponse: Response;

  if (isDevelopmentVoicevox()) {
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
    synthesisResponse = await fetchVoicevox(`/frame_synthesis?speaker=${FRAME_SYNTHESIS_SPEAKER}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(queryPayload),
    }, {
      timeoutMs: 120_000,
      failureMessage: "VOICEVOX Engine に歌声合成を依頼できませんでした。Engine の起動、CORS 許可、ブラウザのローカルネットワークアクセス許可を確認してください。",
    });
  } else {
    // The Worker owns both VOICEVOX Engine calls and fixed speaker IDs. The
    // browser submits only its generated score and a short-lived voice grant.
    onProgress?.("query_ready");
    onProgress?.("synthesis_requested");
    const shortLivedVoiceGrant = voiceGrant?.trim();
    if (!shortLivedVoiceGrant) {
      throw new Error("歌声の音声チケットが見つかりません。新しい歌を作ってから、もう一度試してください。");
    }
    synthesisResponse = await fetchVoicevox("/synthesize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ voiceGrant: shortLivedVoiceGrant, score }),
    }, {
      timeoutMs: 120_000,
      failureMessage: "歌声のサーバーに合成を依頼できませんでした。少し待ってから、もう一度試してください。",
    });
  }

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
