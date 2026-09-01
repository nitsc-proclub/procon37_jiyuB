const encoder = new TextEncoder();
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64 = /^[A-Za-z0-9_-]+$/;
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const b64 = (bytes: ArrayBuffer) => {
  let s = "";
  for (const n of new Uint8Array(bytes)) s += String.fromCharCode(n);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const unb64 = (value: string) => {
  if (!B64.test(value)) return null;
  try {
    return Uint8Array.from(
      atob(
        value
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(Math.ceil(value.length / 4) * 4, "="),
      ),
      (x) => x.charCodeAt(0),
    );
  } catch {
    return null;
  }
};
const key = (secret: string, use: KeyUsage[]) =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    use,
  );
export type ArchiveGenerationTicketInput = {
  generationId: string;
  evaluationFingerprint: string;
  imageSha256?: string;
  analysisSha256: string;
  candidateSha256: string;
};
export const issueArchiveGenerationTicket = async (
  input: ArchiveGenerationTicketInput,
  secret: string,
  now = Date.now(),
  ttlSeconds = 3600,
) => {
  if (
    !UUID.test(input.generationId) ||
    secret.length < 32 ||
    !Number.isSafeInteger(now)
  )
    throw new Error("invalid archive ticket input");
  const expiresAt = now + Math.max(60, Math.min(ttlSeconds, 3600)) * 1000;
  const payload = JSON.stringify(canonical({ v: 1, ...input, expiresAt }));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret, ["sign"]),
    encoder.encode(payload),
  );
  return {
    value: `ca1.${b64(encoder.encode(payload).buffer)}.${b64(signature)}`,
    expiresAt,
  };
};
export const verifyArchiveGenerationTicket = async (
  value: string,
  secret: string,
  now = Date.now(),
): Promise<ArchiveGenerationTicketInput | null> => {
  const [version, encoded, signed, extra] = value.split(".");
  if (version !== "ca1" || !encoded || !signed || extra || secret.length < 32)
    return null;
  const raw = unb64(encoded),
    signature = unb64(signed);
  if (!raw || !signature) return null;
  let payload: ArchiveGenerationTicketInput & { v: number; expiresAt: number };
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (
    payload.v !== 1 ||
    !UUID.test(payload.generationId) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= now ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.evaluationFingerprint) ||
    !/^[a-f0-9]{64}$/.test(payload.analysisSha256) ||
    !/^[a-f0-9]{64}$/.test(payload.candidateSha256) ||
    (payload.imageSha256 !== undefined &&
      !/^[a-f0-9]{64}$/.test(payload.imageSha256))
  )
    return null;
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await key(secret, ["verify"]),
      signature,
      raw,
    ))
  )
    return null;
  return {
    generationId: payload.generationId,
    evaluationFingerprint: payload.evaluationFingerprint,
    ...(payload.imageSha256 ? { imageSha256: payload.imageSha256 } : {}),
    analysisSha256: payload.analysisSha256,
    candidateSha256: payload.candidateSha256,
  };
};
