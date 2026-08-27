import { ensureVoicevoxOk, fetchLocalVoicevox } from "./voicevoxHttp";
import { VoicevoxResolvedServerId, VoicevoxServerId } from "./voicevoxRouting";

export type VoicevoxVersionProbeResult = {
  /** The actual backend selected by an `auto` probe, when the server reports it. */
  server: VoicevoxResolvedServerId | null;
  version: string | null;
};

const VERSION_PATH = "/version";

const parseVersionPayload = (value: unknown): string | null => {
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
  });
  await ensureVoicevoxOk(response, "VOICEVOXサーバーの状態を確認できませんでした。");
  const payload = await response.json().catch(() => null) as unknown;
  return {
    server: parseResolvedServer(
      payload && typeof payload === "object" && "backend" in payload
        ? (payload as Record<string, unknown>).backend
        : backend,
    ),
    version: parseVersionPayload(payload),
  };
};

/**
 * Checks a selected Engine only when the user presses the selector button.
 *
 * Remote checks use the Worker endpoint `/api/voicevox/status?backend=...`.
 * The endpoint should return `{ version, backend? }`.
 */
export const checkVoicevoxServerVersion = async (server: VoicevoxServerId): Promise<VoicevoxVersionProbeResult> => {
  if (server === "local") {
    const response = await fetchLocalVoicevox(VERSION_PATH, { cache: "no-store" }, {
      timeoutMs: 4_000,
      failureMessage: "このパソコンのVOICEVOX Engineに接続できませんでした。",
    });
    await ensureVoicevoxOk(response, "このパソコンのVOICEVOX Engineの状態を確認できませんでした。");
    const payload = await response.json().catch(() => null) as unknown;
    return { server: "local", version: parseVersionPayload(payload) };
  }

  if (server === "auto") {
    // This branch runs only after the explicit status button is pressed. It
    // is allowed to test both remote candidates, including Cloud Run startup.
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
