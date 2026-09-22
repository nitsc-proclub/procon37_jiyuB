/**
 * Visitor-selectable VOICEVOX routing.
 *
 * `auto` is the normal production mode. The Worker chooses the remote backend
 * (including queue overflow to Cloud Run), while the browser may try its own
 * loopback Engine before asking the Worker. The other values are intentional
 * debug overrides and must not be treated as health checks.
 */
export const VOICEVOX_SERVER_IDS = ["auto", "local", "cloudflare-vpc", "google-cloud-run"] as const;

export type VoicevoxServerId = (typeof VOICEVOX_SERVER_IDS)[number];
export type VoicevoxResolvedServerId = Exclude<VoicevoxServerId, "auto">;

export const VOICEVOX_SERVER_LABELS: Record<VoicevoxServerId, string> = {
  auto: "自動（ローカル優先・クラウド振り分け）",
  local: "ローカルVOICEVOX",
  "cloudflare-vpc": "みらいサーバー",
  "google-cloud-run": "Google Cloud Run",
};

export const VOICEVOX_SERVER_SHORT_LABELS: Record<VoicevoxServerId | VoicevoxResolvedServerId, string> = {
  auto: "自動",
  local: "ローカルVOICEVOX",
  "cloudflare-vpc": "みらいサーバー",
  "google-cloud-run": "Google Cloud Run",
};

export const VOICEVOX_SERVER_SELECTION_STORAGE_KEY = "ekaki-uta:voicevox-server-selection-v1";

export type VoicevoxServerHealthStatus = "unknown" | "checking" | "configured" | "connected" | "unavailable";

export type VoicevoxServerHealth = {
  status: VoicevoxServerHealthStatus;
  version?: string | null;
  message?: string | null;
};

export const normalizeVoicevoxServerId = (value: unknown): VoicevoxServerId =>
  typeof value === "string" && (VOICEVOX_SERVER_IDS as readonly string[]).includes(value)
    ? value as VoicevoxServerId
    : "auto";

export const getVoicevoxServerLabel = (server: VoicevoxServerId | VoicevoxResolvedServerId | null | undefined) =>
  server ? VOICEVOX_SERVER_SHORT_LABELS[server] : "未選択";
