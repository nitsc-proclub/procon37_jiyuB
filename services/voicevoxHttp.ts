const DEV_VOICEVOX_BASE_URL = "/voicevox";

// These are deliberately fixed loopback origins. Do not accept a URL from the
// page, query string, or generated content: a public deployment must never be
// able to turn the visitor's browser into a general local-network client.
export const DIRECT_VOICEVOX_BASE_URLS = [
  "http://127.0.0.1:50021",
  "http://localhost:50021",
] as const;

const PROBE_TIMEOUT_MS = 4_000;
const REQUEST_TIMEOUT_MS = 30_000;

let resolvedDirectBaseUrl: string | null = null;
let developmentProxyVerified = false;
let probeInFlight: Promise<string> | null = null;

export class VoicevoxConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoicevoxConnectionError";
  }
}

type VoicevoxFetchOptions = {
  timeoutMs?: number;
  /** Probe callers need a neutral error while synthesis needs user guidance. */
  failureMessage?: string;
};

const isDevelopmentProxy = () => import.meta.env.DEV;

const describeDirectConnectionProblem = () =>
  "VOICEVOX Engine に接続できませんでした。Engineを起動し、VOICEVOXの設定で https://cho-ekaki-uta.nitsc-proclub.workers.dev をCORS許可Originへ追加して、ブラウザのローカルネットワークアクセスを許可してください。";

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  { timeoutMs = REQUEST_TIMEOUT_MS, failureMessage = describeDirectConnectionProblem() }: VoicevoxFetchOptions = {},
) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new VoicevoxConnectionError(`${failureMessage} (${Math.ceil(timeoutMs / 1000)}秒でタイムアウトしました。)`);
    }

    if (error instanceof TypeError) {
      throw new VoicevoxConnectionError(failureMessage);
    }

    throw error;
  } finally {
    window.clearTimeout(timer);
  }
};

/**
 * Finds a VOICEVOX Engine running on the computer that opened the page.
 *
 * During Vite development requests continue through the existing /voicevox
 * proxy, so the pre-existing local workflow is unchanged. In built apps this
 * probes only the two explicitly allowed loopback endpoints.
 */
export const probeVoicevox = async (): Promise<string> => {
  if (isDevelopmentProxy() && developmentProxyVerified) {
    return DEV_VOICEVOX_BASE_URL;
  }

  if (!isDevelopmentProxy() && resolvedDirectBaseUrl) {
    return resolvedDirectBaseUrl;
  }

  if (probeInFlight) {
    return probeInFlight;
  }

  probeInFlight = (async () => {
    if (isDevelopmentProxy()) {
      const response = await fetchWithTimeout(`${DEV_VOICEVOX_BASE_URL}/version`, { cache: "no-store" }, {
        timeoutMs: PROBE_TIMEOUT_MS,
        failureMessage: "VOICEVOX Engine に接続できませんでした。Vite サーバーと VOICEVOX Engine が起動しているか確認してください。",
      });
      await ensureVoicevoxOk(response, "VOICEVOX Engine の状態を確認できませんでした。");
      developmentProxyVerified = true;
      return DEV_VOICEVOX_BASE_URL;
    }

    for (const baseUrl of DIRECT_VOICEVOX_BASE_URLS) {
      try {
        const response = await fetchWithTimeout(`${baseUrl}/version`, { cache: "no-store" }, {
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        if (!response.ok) {
          continue;
        }
        resolvedDirectBaseUrl = baseUrl;
        return baseUrl;
      } catch (error) {
        if (!(error instanceof VoicevoxConnectionError)) {
          throw error;
        }
      }
    }

    throw new VoicevoxConnectionError(describeDirectConnectionProblem());
  })();

  try {
    return await probeInFlight;
  } finally {
    probeInFlight = null;
  }
};

export const resetVoicevoxConnection = () => {
  resolvedDirectBaseUrl = null;
  developmentProxyVerified = false;
  probeInFlight = null;
};

/**
 * Uses the Vite proxy in development and a previously probed loopback Engine
 * elsewhere. The probe also gives a single, actionable error for unavailable
 * Engine/CORS/Local Network Access cases instead of exposing fetch internals.
 */
export const fetchVoicevox = async (
  path: string,
  init: RequestInit,
  options?: VoicevoxFetchOptions,
) => {
  const baseUrl = await probeVoicevox();
  return fetchWithTimeout(`${baseUrl}${path}`, init, options);
};

const readErrorText = async (response: Response) => {
  try {
    return await response.text();
  } catch {
    return "";
  }
};

export const ensureVoicevoxOk = async (response: Response, defaultMessage: string) => {
  if (response.ok) {
    return;
  }

  const details = await readErrorText(response);
  const suffix = details ? ` ${details}` : "";
  throw new Error(`${defaultMessage} (${response.status})${suffix}`);
};
