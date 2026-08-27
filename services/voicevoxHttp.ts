const DEV_VOICEVOX_BASE_URL = "/voicevox";
const WORKER_VOICEVOX_BASE_URL = "/api/voicevox";

// Keep automatic probing on loopback. A visitor may explicitly select a
// VOICEVOX Engine on the same private IPv4 network via the settings UI.
export const DIRECT_VOICEVOX_BASE_URLS = [
  "http://127.0.0.1:50021",
  "http://localhost:50021",
] as const;

const PROBE_TIMEOUT_MS = 4_000;
const REQUEST_TIMEOUT_MS = 30_000;

let resolvedDirectBaseUrl: string | null = null;
let configuredDirectBaseUrl: string | null = null;
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

export const isDevelopmentVoicevox = () => import.meta.env.DEV;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const isPrivateIpv4Host = (hostname: string) => {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
};

/**
 * Normalizes a visitor-selected VOICEVOX Engine URL without widening the
 * public app's local-network access. A public page may call loopback HTTP
 * origins or an explicitly selected RFC 1918 IPv4 host on VOICEVOX's port.
 * Paths, credentials, queries, and fragments are not accepted.
 */
export const normalizeDirectVoicevoxBaseUrl = (value: string): string => {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    throw new VoicevoxConnectionError("VOICEVOXのURLを入力してください。例: http://127.0.0.1:50021");
  }

  if (
    url.protocol !== "http:"
    || (!LOOPBACK_HOSTS.has(url.hostname) && !(isPrivateIpv4Host(url.hostname) && url.port === "50021"))
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new VoicevoxConnectionError("VOICEVOXの接続先には、localhost・127.0.0.1・[::1]、または同じネットワーク内のプライベートIPv4アドレス（ポート50021）を指定できます。");
  }

  return url.origin;
};

export const getDirectVoicevoxBaseUrl = () => configuredDirectBaseUrl ?? DIRECT_VOICEVOX_BASE_URLS[0];

export const setDirectVoicevoxBaseUrl = (value: string) => {
  const normalizedBaseUrl = normalizeDirectVoicevoxBaseUrl(value);
  // Keep the original 127.0.0.1 -> localhost fallback when the default is
  // selected. A user-selected alternative endpoint is probed by itself.
  configuredDirectBaseUrl = normalizedBaseUrl === DIRECT_VOICEVOX_BASE_URLS[0]
    ? null
    : normalizedBaseUrl;
  resolvedDirectBaseUrl = null;
  probeInFlight = null;
  return normalizedBaseUrl;
};

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
 * proxy, so the pre-existing local workflow is unchanged. Built apps may
 * explicitly opt into this local probe from the server selector; no probe is
 * started by this module on its own.
 */
export const probeVoicevox = async (): Promise<string> => {
  if (isDevelopmentVoicevox() && developmentProxyVerified) {
    return DEV_VOICEVOX_BASE_URL;
  }

  if (!isDevelopmentVoicevox() && resolvedDirectBaseUrl) {
    return resolvedDirectBaseUrl;
  }

  if (probeInFlight) {
    return probeInFlight;
  }

  probeInFlight = (async () => {
    if (isDevelopmentVoicevox()) {
      const response = await fetchWithTimeout(`${DEV_VOICEVOX_BASE_URL}/version`, { cache: "no-store" }, {
        timeoutMs: PROBE_TIMEOUT_MS,
        failureMessage: "VOICEVOX Engine に接続できませんでした。Vite サーバーと VOICEVOX Engine が起動しているか確認してください。",
      });
      await ensureVoicevoxOk(response, "VOICEVOX Engine の状態を確認できませんでした。");
      developmentProxyVerified = true;
      return DEV_VOICEVOX_BASE_URL;
    }

    const candidates = configuredDirectBaseUrl
      ? [configuredDirectBaseUrl]
      : [...DIRECT_VOICEVOX_BASE_URLS];
    let lastError: unknown = null;

    for (const baseUrl of candidates) {
      try {
        const response = await fetchWithTimeout(`${baseUrl}/version`, { cache: "no-store" }, {
          timeoutMs: PROBE_TIMEOUT_MS,
          failureMessage: "このパソコンのVOICEVOX Engineに接続できませんでした。",
        });
        await ensureVoicevoxOk(response, "このパソコンのVOICEVOX Engineの状態を確認できませんでした。");
        resolvedDirectBaseUrl = baseUrl;
        return baseUrl;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new VoicevoxConnectionError("このパソコンのVOICEVOX Engineに接続できませんでした。");
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
 * Development uses the existing Vite proxy and local Engine. Built apps call
 * only the Worker's fixed VOICEVOX routes; browsers never receive the Cloud
 * Run URL or credentials. The one-time voice grant travels only inside the
 * fixed synthesis request body, not as a reusable authorization header.
 */
export const fetchVoicevox = async (
  path: string,
  init: RequestInit,
  options?: VoicevoxFetchOptions,
) => {
  if (isDevelopmentVoicevox()) {
    const baseUrl = await probeVoicevox();
    return fetchWithTimeout(`${baseUrl}${path}`, init, options);
  }

  return fetchWithTimeout(`${WORKER_VOICEVOX_BASE_URL}${path}`, init, {
    ...options,
    failureMessage: options?.failureMessage ?? "歌声のサーバーに接続できませんでした。少し待ってから、もう一度試してください。",
  });
};

/**
 * Calls the visitor's explicitly selected local Engine. This is separate from
 * fetchVoicevox so production never silently bypasses the Worker route.
 */
export const fetchLocalVoicevox = async (
  path: string,
  init: RequestInit,
  options?: VoicevoxFetchOptions,
) => {
  const baseUrl = await probeVoicevox();
  return fetchWithTimeout(`${baseUrl}${path}`, init, {
    ...options,
    failureMessage: options?.failureMessage ?? describeDirectConnectionProblem(),
  });
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
