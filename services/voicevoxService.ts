import { SingingScore } from "../types";

const DEV_VOICEVOX_BASE_URL = "/voicevox";
const PROD_VOICEVOX_BASE_URL = "http://127.0.0.1:50021";
const SING_QUERY_SPEAKER = 6000;
const FRAME_SYNTHESIS_SPEAKER = 3003;

export type VoicevoxProgressStage =
  | "query_requested"
  | "query_ready"
  | "synthesis_requested"
  | "synthesis_ready";

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

export const synthesizeSingingVoice = async (
  score: SingingScore,
  onProgress?: (stage: VoicevoxProgressStage) => void,
): Promise<Blob> => {
  const baseUrl = getVoicevoxBaseUrl();
  let queryResponse: Response;

  try {
    onProgress?.("query_requested");
    queryResponse = await fetch(`${baseUrl}/sing_frame_audio_query?speaker=${SING_QUERY_SPEAKER}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(score),
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        "VOICEVOX Engine に接続できません。開発中は Vite サーバーを再起動し、VOICEVOX Engine が 127.0.0.1:50021 で動いているか確認してください。",
      );
    }

    throw error;
  }

  await ensureOk(queryResponse, "VOICEVOX の歌唱クエリ生成に失敗しました。");
  onProgress?.("query_ready");

  const queryPayload = await queryResponse.json();

  onProgress?.("synthesis_requested");
  const synthesisResponse = await fetch(`${baseUrl}/frame_synthesis?speaker=${FRAME_SYNTHESIS_SPEAKER}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(queryPayload),
  });

  await ensureOk(synthesisResponse, "VOICEVOX の音声合成に失敗しました。");
  onProgress?.("synthesis_ready");

  return synthesisResponse.blob();
};
