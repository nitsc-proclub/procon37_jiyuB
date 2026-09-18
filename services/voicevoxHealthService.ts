import { ensureVoicevoxOk, fetchLocalVoicevox } from "./voicevoxHttp";
import { VoicevoxResolvedServerId, VoicevoxServerId } from "./voicevoxRouting";

export type VoicevoxVersionProbeResult = {
  /** The actual backend selected by an `auto` probe, when the server reports it. */
  server: VoicevoxResolvedServerId | null;
  version: string | null;
  liveCheck: boolean;
};

const VERSION_PATH = "/version";

const parseVersionPayload = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.version === "string" && record.version.trim().length > 0 ? record.version.trim() : null;
};

const parseResolvedServer = (value: unknown): VoicevoxResolvedServerId | null => {
  if (value === "local" || value === "cloudflare-vpc" || value === "google-cloud-run") return value;
  if (value === "vpc") return "cloudflare-vpc";
  if (value === "cloud-run") return "google-cloud-run";
  return null;
};

const toBackendName = (server: Exclude<VoicevoxServerId, "auto" | "local">) =>
  server === "cloudflare-vpc" ? "vpc" : "cloud-run";

const checkRemoteBackend = async (backend: "vpc" | "cloud-run") => {
  const response = await fetch(`/api/voicevox/status?backend=${encodeURIComponent(backend)}`, {
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(65_000),
  });
  await ensureVoicevoxOk(response, "VOICEVOXサーバーの状態を確認できませんでした。");
  const payload = await response.json().catch(() => null) as unknown;
  if (!payload || typeof payload !== "object" || !("available" in payload) || payload.available !== true) {
    throw new Error("歌声サーバーの接続を確認できませんでした。確認APIの応答またはサーバー設定を確認してください。");
  }
  const record = payload as Record<string, unknown>;
  if (record.backend !== backend) throw new Error("選択した歌声サーバーと確認結果が一致しません。");
  const liveCheck = record.liveCheck !== false;
  const version = parseVersionPayload(payload);
  if (liveCheck && !version) throw new Error("歌声サーバーのバージョンを取得できませんでした。");
  return {
    server: parseResolvedServer(record.backend),
    version,
    liveCheck,
  };
};

/**
 * Checks a selected Engine only when the user presses the selector button.
 *
 * Remote checks use the Worker endpoint `/api/voicevox/status?backend=...`.
 * A configuration-only response must never be described as a live connection.
 */
export const checkVoicevoxServerVersion = async (server: VoicevoxServerId): Promise<VoicevoxVersionProbeResult> => {
  if (server === "local") {
    const response = await fetchLocalVoicevox(VERSION_PATH, { cache: "no-store" }, {
      timeoutMs: 4_000,
      failureMessage: "このパソコンのVOICEVOX Engineに接続できませんでした。",
    });
    await ensureVoicevoxOk(response, "このパソコンのVOICEVOX Engineの状態を確認できませんでした。");
    const payload = await response.json().catch(() => null) as unknown;
    const version = parseVersionPayload(payload);
    if (!version) throw new Error("ローカルVOICEVOXのバージョンを取得できませんでした。");
    return { server: "local", version, liveCheck: true };
  }

  if (server === "auto") {
    // Local relay checks can start Cloud Run; public checks only report its
    // configuration. Preserve that distinction in the result.
    try {
      return await checkRemoteBackend("vpc");
    } catch (vpcError) {
      try {
        return await checkRemoteBackend("cloud-run");
      } catch (cloudRunError) {
        if (cloudRunError instanceof Error && vpcError instanceof Error) {
          throw new Error(`Cloudflare VPC: ${vpcError.message} / Google Cloud Run: ${cloudRunError.message}`);
        }
        throw cloudRunError;
      }
    }
  }

  return checkRemoteBackend(toBackendName(server));
};
