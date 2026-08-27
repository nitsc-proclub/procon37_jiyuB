import { SingingScore } from "../types";
import { ensureVoicevoxOk, fetchLocalVoicevox, fetchVoicevox, isDevelopmentVoicevox } from "./voicevoxHttp";
import { VoicevoxResolvedServerId, VoicevoxServerId } from "./voicevoxRouting";

const SING_QUERY_SPEAKER = 6000;
const FRAME_SYNTHESIS_SPEAKER = 3003;

export type VoicevoxProgressStage =
  | "query_requested"
  | "query_ready"
  | "synthesis_requested"
  | "synthesis_ready";

export type VoicevoxSynthesisOptions = {
  /** `auto` tries local first, then lets the Worker use its remote fallback. */
  server?: VoicevoxServerId;
  /** Called only after a valid WAV response identifies the actual server. */
  onServerResolved?: (server: VoicevoxResolvedServerId) => void;
};

const toBackendName = (server: Exclude<VoicevoxServerId, "local">) => {
  if (server === "cloudflare-vpc") return "vpc" as const;
  if (server === "google-cloud-run") return "cloud-run" as const;
  return "auto" as const;
};

const fromBackendName = (value: string | null): VoicevoxResolvedServerId | null => {
  if (value === "vpc") return "cloudflare-vpc";
  if (value === "cloud-run") return "google-cloud-run";
  return null;
};

const assertWavResponse = async (response: Response, defaultMessage: string) => {
  await ensureVoicevoxOk(response, defaultMessage);
  const audioBlob = await response.blob();
  const header = new Uint8Array(await audioBlob.slice(0, 12).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...header.slice(start, end));
  if (header.length < 12 || ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WAVE") {
    throw new Error("VOICEVOXからWAV形式の歌声を受け取れませんでした。");
  }
  return audioBlob;
};

const synthesizeLocally = async (
  score: SingingScore,
  onProgress: ((stage: VoicevoxProgressStage) => void) | undefined,
  onServerResolved: ((server: VoicevoxResolvedServerId) => void) | undefined,
) => {
  onProgress?.("query_requested");
  const queryResponse = await fetchLocalVoicevox(`/sing_frame_audio_query?speaker=${SING_QUERY_SPEAKER}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(score),
  }, {
    timeoutMs: 60_000,
    failureMessage: "VOICEVOX Engine に歌唱クエリを送信できませんでした。Engineの起動、CORS許可、ローカルネットワークアクセス許可を確認してください。",
  });

  await ensureVoicevoxOk(queryResponse, "VOICEVOXの歌唱クエリ生成に失敗しました。");
  onProgress?.("query_ready");
  const queryPayload = await queryResponse.json();

  onProgress?.("synthesis_requested");
  const synthesisResponse = await fetchLocalVoicevox(`/frame_synthesis?speaker=${FRAME_SYNTHESIS_SPEAKER}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(queryPayload),
  }, {
    timeoutMs: 120_000,
    failureMessage: "VOICEVOX Engine に歌声合成を依頼できませんでした。Engineの起動、CORS許可、ローカルネットワークアクセス許可を確認してください。",
  });

  const audioBlob = await assertWavResponse(synthesisResponse, "VOICEVOXの歌声合成に失敗しました。");
  onProgress?.("synthesis_ready");
  onServerResolved?.("local");
  return audioBlob;
};

const synthesizeThroughWorker = async (
  score: SingingScore,
  onProgress: ((stage: VoicevoxProgressStage) => void) | undefined,
  voiceGrant: string | undefined,
  server: Exclude<VoicevoxServerId, "local">,
  onServerResolved: ((server: VoicevoxResolvedServerId) => void) | undefined,
) => {
  // The Worker owns both VOICEVOX Engine calls and fixed speaker IDs. The
  // browser submits only its generated score, a short-lived grant, and the
  // optional routing override. The routing field is a temporary frontend
  // contract; the Worker may ignore `auto` and apply its own priority order.
  onProgress?.("query_ready");
  onProgress?.("synthesis_requested");
  const shortLivedVoiceGrant = voiceGrant?.trim();
  if (!shortLivedVoiceGrant) {
    throw new Error("歌声の音声チケットが見つかりません。新しい歌を作ってから、もう一度試してください。");
  }
  const synthesisResponse = await fetchVoicevox("/synthesize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ voiceGrant: shortLivedVoiceGrant, score, backend: toBackendName(server) }),
  }, {
    timeoutMs: 120_000,
    failureMessage: "歌声のサーバーに合成を依頼できませんでした。少し待ってから、もう一度試してください。",
  });

  const audioBlob = await assertWavResponse(synthesisResponse, "VOICEVOXの歌声合成に失敗しました。");
  onProgress?.("synthesis_ready");
  const responseServer = synthesisResponse.headers.get("X-Voicevox-Backend");
  const resolvedServer = fromBackendName(responseServer)
    ?? (server === "cloudflare-vpc" || server === "google-cloud-run"
      ? server
      : null);
  if (resolvedServer) onServerResolved?.(resolvedServer);
  return audioBlob;
};

export const synthesizeSingingVoice = async (
  score: SingingScore,
  onProgress?: (stage: VoicevoxProgressStage) => void,
  voiceGrant?: string,
  options?: VoicevoxSynthesisOptions,
): Promise<Blob> => {
  const requestedServer = options?.server ?? (isDevelopmentVoicevox() ? "local" : "auto");

  if (requestedServer === "local") {
    return synthesizeLocally(score, onProgress, options?.onServerResolved);
  }

  if (requestedServer === "auto") {
    try {
      // Automatic generation probes only the local Engine here. Remote
      // health checks are deliberately user-triggered in the selector UI.
      return await synthesizeLocally(score, onProgress, options?.onServerResolved);
    } catch (localError) {
      try {
        return await synthesizeThroughWorker(score, onProgress, voiceGrant, "auto", options?.onServerResolved);
      } catch (remoteError) {
        // Preserve the remote API's actionable message while retaining a
        // little context for desktop debugging when both routes fail.
        if (remoteError instanceof Error && localError instanceof Error) {
          throw new Error(`${remoteError.message}（ローカルVOICEVOXも利用できませんでした）`);
        }
        throw remoteError;
      }
    }
  }

  return synthesizeThroughWorker(score, onProgress, voiceGrant, requestedServer, options?.onServerResolved);
};
