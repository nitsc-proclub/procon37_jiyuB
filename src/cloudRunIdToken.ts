type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  type?: string;
};

const encoder = new TextEncoder();

const base64Url = (bytes: ArrayBuffer | Uint8Array) => {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const pemToPkcs8 = (pem: string) => {
  const normalized = pem.trim();
  const match = normalized.match(/^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/);
  if (!match) throw new Error("The service account private key is not PKCS#8 PEM.");
  const binary = atob(match[1].replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer;
};

const parseServiceAccount = (value: string): GoogleServiceAccount => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The service account secret is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("The service account secret is not an object.");
  const account = parsed as Partial<GoogleServiceAccount>;
  if (
    (account.type !== undefined && account.type !== "service_account") ||
    typeof account.client_email !== "string" ||
    !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(account.client_email) ||
    typeof account.private_key !== "string" ||
    account.private_key.length > 8_192 ||
    (account.private_key_id !== undefined && (typeof account.private_key_id !== "string" || account.private_key_id.length > 256))
  ) {
    throw new Error("The service account secret is missing required fields.");
  }
  return account as GoogleServiceAccount;
};

/**
 * Exchanges a signed service-account JWT for a Google-signed ID token whose
 * audience is the exact Cloud Run service URL. The JSON key stays in a
 * Cloudflare secret binding and is never sent to the browser or Cloud Run.
 */
export const createCloudRunIdToken = async (serviceAccountJson: string, audience: string, now = Date.now()) => {
  const account = parseServiceAccount(serviceAccountJson);
  const issuedAt = Math.floor(now / 1_000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    ...(account.private_key_id ? { kid: account.private_key_id } : {}),
  };
  const claims = {
    iss: account.client_email,
    sub: account.client_email,
    aud: "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 600,
    target_audience: audience,
  };
  const unsignedToken = `${base64Url(encoder.encode(JSON.stringify(header)))}.${base64Url(encoder.encode(JSON.stringify(claims)))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsignedToken));
  const assertion = `${unsignedToken}.${base64Url(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`Google ID-token exchange failed (${response.status}).`);
  const payload = await response.json() as { id_token?: unknown };
  if (typeof payload.id_token !== "string" || payload.id_token.length < 32 || payload.id_token.length > 16_384) {
    throw new Error("Google ID-token exchange did not return an ID token.");
  }
  return payload.id_token;
};
