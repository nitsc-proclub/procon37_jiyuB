import type { LyricsCandidate, Phase1LyricsResponse } from "../types";
import { buildAlignedAccentHint, type VoicevoxAccentPhrase } from "../services/voicevoxAccentAlignment";
import { fetchVoicevoxBackend, type VoicevoxBackendEnv } from "./voicevoxBackend";

const ANALYSIS_BUDGET_MS = 6_000;
const LINE_TIMEOUT_MS = 1_500;
const MAX_RESPONSE_BYTES = 64 * 1024;

const parsePhrases = (value: unknown): VoicevoxAccentPhrase[] => {
  if (!Array.isArray(value) || value.length > 128 || !value.every(phrase =>
    phrase && Array.isArray(phrase.moras) && phrase.moras.length <= 128 &&
    phrase.moras.every((mora: { text?: unknown; pitch?: unknown }) => mora && typeof mora.text === "string" && mora.text.length <= 16 && typeof mora.pitch === "number" && Number.isFinite(mora.pitch)),
  )) throw new Error("Invalid accent phrases");
  return value as VoicevoxAccentPhrase[];
};

// Bound both headers and body. An optional analysis must not block song creation.
const readPhrases = async (response: Response, timeoutMs: number) => {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Accent analysis unavailable");
  }
  const reader = response.body.getReader();
  const timeout = setTimeout(() => { void reader.cancel().catch(() => undefined); }, timeoutMs);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Accent response too large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return parsePhrases(JSON.parse(new TextDecoder().decode(bytes)));
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

/** Runs only within the Turnstile-authorized generation, never as a public proxy. */
export const analyzePublicAccents = async (
  candidates: LyricsCandidate[],
  env: VoicevoxBackendEnv & { VOICEVOX_ACCENT_ENABLED?: string },
): Promise<Phase1LyricsResponse["accentHints"]> => {
  if (env.VOICEVOX_ACCENT_ENABLED !== "true" || !env.VOICEVOX) return undefined;
  const hints: NonNullable<Phase1LyricsResponse["accentHints"]> = {};
  const deadline = Date.now() + ANALYSIS_BUDGET_MS;
  try {
    // Analysis is optional: use the existing VPC engine without cold-starting Cloud Run.
    const backend = "vpc";
    const cache = new Map<string, ReturnType<typeof buildAlignedAccentHint>>();
    for (const candidate of candidates) {
      const lines = candidate.singingKanaLines ?? [];
      hints[candidate.candidateId] = [];
      for (const line of lines) {
        let hint = cache.get(line);
        if (!hint && Date.now() < deadline) {
          try {
            const query = new URLSearchParams({ speaker: "3", text: line });
            const response = await fetchVoicevoxBackend(env, backend, `/accent_phrases?${query}`, { method: "POST" }, Math.min(LINE_TIMEOUT_MS, deadline - Date.now()));
            hint = buildAlignedAccentHint(line, await readPhrases(response, Math.max(1, Math.min(LINE_TIMEOUT_MS, deadline - Date.now()))));
          } catch { hint = { levels: [] }; }
          cache.set(line, hint);
        }
        hints[candidate.candidateId]!.push(hint ?? { levels: [] });
      }
    }
    return hints;
  } catch {
    return undefined;
  }
};
