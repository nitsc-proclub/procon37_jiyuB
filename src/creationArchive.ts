import { verifyArchiveGenerationTicket } from "./creationArchiveTicket";
export const CREATION_ARCHIVE_CONSENT_VERSION = "creation-archive-v1",
  CREATION_ARCHIVE_RETENTION_MS = 365 * 86400000,
  CREATION_ARCHIVE_PENDING_MS = 3600000,
  CREATION_ARCHIVE_QUOTA_BYTES = 8_000_000_000;
const TOTAL = 72 * 1024 * 1024,
  IMG = 4 * 1024 * 1024,
  JSONMAX = 4 * 1024 * 1024,
  WAV = 32 * 1024 * 1024,
  REQUIRED = [
    "input-image",
    "drawing-json",
    "candidate-a-json",
    "candidate-b-json",
    "manifest",
  ] as const,
  NAMES = [...REQUIRED, "candidate-a-wav", "candidate-b-wav"] as const;
type Name = (typeof NAMES)[number];
type Stmt = {
  bind(...v: unknown[]): Stmt;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T extends Record<string, unknown>>(): Promise<T | null>;
  all<T extends Record<string, unknown>>(): Promise<{ results: T[] }>;
};
export type CreationArchiveDatabase = {
  prepare(s: string): Stmt;
  batch(s: Stmt[]): Promise<unknown>;
};
export type CreationArchiveBucket = {
  put(k: string, v: Uint8Array, o?: { sha256?: string; httpMetadata?: { contentType?: string } }): Promise<{ size: number } | null>;
  delete(k: string | string[]): Promise<void>;
};
export type CreationArchiveEnv = {
  CREATION_ARCHIVES: CreationArchiveBucket;
  EVALUATIONS_DB: CreationArchiveDatabase;
  EVALUATION_RECEIPT_SECRET: string;
};
export class CreationArchiveError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const E = new TextEncoder(),
  UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  HEX = /^[a-f0-9]{64}$/;
const hex = async (v: string | Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof v === "string" ? E.encode(v) : v,
      ),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
const b64 = (a: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(a)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const sign = async (s: string, v: string) =>
  b64(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        E.encode(s),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      E.encode(v),
    ),
  );
const cap = (s: string, id: string, k: string) =>
  sign(s, `creation-archive-v1:${id}:${k}`);
const validCapability = async (secret: string, id: string, kind: string, value: string) => {
  if (!UUID.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const signature = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "="), c => c.charCodeAt(0));
  return crypto.subtle.verify("HMAC", await crypto.subtle.importKey("raw", E.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]), signature, E.encode(`creation-archive-v1:${id}:${kind}`));
};
const aid = async (s: string, g: string) => {
  const h = await sign(s, `creation-archive-id:${g}`);
  const a = Uint8Array.from(
    atob(h.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=")),
    (x) => x.charCodeAt(0),
  ).slice(0, 16);
  a[6] = (a[6] & 15) | 64;
  a[8] = (a[8] & 63) | 128;
  const x = Array.from(a, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};
const rkey = (id: string, n: Name) => `archives/v1/${id}/${n}`;
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
const canonicalHash = (v: unknown) => hex(JSON.stringify(canonical(v)));
type D = { name: Name; bytes: number; sha256: string; contentType: string };
const specs = (v: unknown) => {
  if (!Array.isArray(v))
    throw new CreationArchiveError(
      400,
      "invalid-assets",
      "保存する作品データが正しくありません。",
    );
  const m = new Map<Name, D>();
  for (const i of v) {
    const x = i as Record<string, unknown>,
      n = x?.name as Name,
      t = String(x?.contentType).toLowerCase();
    if (
      !x ||
      typeof x !== "object" ||
      !NAMES.includes(n) ||
      m.has(n) ||
      !Number.isSafeInteger(x.bytes) ||
      Number(x.bytes) < 1 ||
      !HEX.test(String(x.sha256)) ||
      !(
        n === "input-image"
          ? ["image/png", "image/webp"]
          : n.endsWith("wav")
            ? ["audio/wav"]
            : ["application/json"]
      ).includes(t)
    )
      throw new CreationArchiveError(
        400,
        "invalid-assets",
        "保存する作品データが正しくありません。",
      );
    m.set(n, {
      name: n,
      bytes: Number(x.bytes),
      sha256: String(x.sha256),
      contentType: t,
    });
  }
  if (!REQUIRED.every((n) => m.has(n)))
    throw new CreationArchiveError(
      400,
      "missing-assets",
      "必要な作品データがありません。",
    );
  if (
    ["drawing-json", "candidate-a-json", "candidate-b-json", "manifest"].reduce(
      (n, x) => n + m.get(x as Name)!.bytes,
      0,
    ) > JSONMAX ||
    m.get("input-image")!.bytes > IMG ||
    ["candidate-a-wav", "candidate-b-wav"].some(
      (x) => (m.get(x as Name)?.bytes ?? 0) > WAV,
    ) ||
    [...m.values()].reduce((n, x) => n + x.bytes, 0) > TOTAL
  )
    throw new CreationArchiveError(
      413,
      "archive-too-large",
      "作品データが大きすぎます。",
    );
  return m;
};
const read = async (b: ReadableStream<Uint8Array>, limit: number) => {
  if (!b) throw new CreationArchiveError(400, "missing-body", "作品データがありません。");
  const r = b.getReader(),
    a: Uint8Array[] = [];
  let n = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void r.cancel("upload-timeout").catch(() => undefined); }, 120_000);
  try {
    for (;;) {
      const q = await r.read();
      if (timedOut) throw new CreationArchiveError(408, "upload-timeout", "保存が時間切れになりました。");
      if (q.done) break;
      n += q.value.length;
      if (n > limit) {
        await r.cancel();
        throw new CreationArchiveError(
          413,
          "asset-too-large",
          "作品データが大きすぎます。",
        );
      }
      a.push(q.value);
    }
  } finally {
    clearTimeout(timer);
    r.releaseLock();
  }
  const o = new Uint8Array(n);
  let p = 0;
  for (const q of a) {
    o.set(q, p);
    p += q.length;
  }
  return o;
};
const mime = (n: Name, t: string, b: Uint8Array) => {
  const f = (x: number) => String.fromCharCode(...b.slice(x, x + 4)),
    png =
      b.length >= 8 &&
      b[0] === 137 &&
      b[1] === 80 && b[2] === 78 && b[3] === 71 &&
      b[4] === 13 &&
      b[5] === 10 &&
      b[6] === 26 &&
      b[7] === 10;
  let ok = n.endsWith("json") || n === "manifest";
  if (ok)
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(b));
      const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
      let count = 0;
      while (pending.length) {
        const item = pending.pop()!;
        if (++count > 100000 || item.depth > 32) throw new Error("JSON limit");
        if (item.value && typeof item.value === "object") {
          for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
        }
      }
    } catch {
      ok = false;
    }
  else if (n === "input-image")
    ok = t === "image/png" ? png : f(0) === "RIFF" && f(8) === "WEBP";
  else ok = f(0) === "RIFF" && f(8) === "WAVE";
  if (!ok)
    throw new CreationArchiveError(
      415,
      "invalid-asset-mime",
      "作品データの形式が正しくありません。",
    );
};
export const initializeCreationArchive = async (
  env: CreationArchiveEnv,
  input: {
    generationId: string;
    consentVersion: string;
    generationTicket: string;
    assets: unknown;
    evaluation: { candidates: readonly { candidateId: string }[] };
  },
  now = Date.now(),
) => {
  if (
    !UUID.test(input.generationId) ||
    input.consentVersion !== CREATION_ARCHIVE_CONSENT_VERSION ||
    !(await verifyArchiveGenerationTicket(
      input.generationTicket,
      env.EVALUATION_RECEIPT_SECRET,
      now,
    ))
  )
    throw new CreationArchiveError(
      403,
      "archive-consent-required",
      "新しい保存同意が必要です。",
    );
  const a = specs(input.assets),
    total = [...a.values()].reduce((n, x) => n + x.bytes, 0),
    id = await aid(env.EVALUATION_RECEIPT_SECRET, input.generationId),
    u = await cap(env.EVALUATION_RECEIPT_SECRET, id, "upload"),
    d = await cap(env.EVALUATION_RECEIPT_SECRET, id, "delete"),
    expected = new Map<string, string>();
  for (const c of input.evaluation.candidates)
    expected.set(c.candidateId, await canonicalHash(c));
  if (
    expected.size !== 2 ||
    !expected.has("candidate-a") ||
    !expected.has("candidate-b")
  )
    throw new CreationArchiveError(
      403,
      "invalid-evaluation-receipt",
      "評価保存の確認に失敗しました。",
    );
  const result = {
      archiveId: id,
      uploadCapability: u,
      deleteCapability: d,
      pendingExpiresAt: now + CREATION_ARCHIVE_PENDING_MS,
      expiresAt: now + CREATION_ARCHIVE_RETENTION_MS,
      assets: [...a.values()].map((x) => ({
        name: x.name,
        maxBytes: x.bytes,
        contentType: x.contentType,
      })),
    };
  const existingResult = async () => {
    const old = await env.EVALUATIONS_DB.prepare("SELECT status,pending_expires_at,expires_at FROM creation_archives WHERE archive_id=?").bind(id).first<{ status: string; pending_expires_at: number; expires_at: number }>();
    if (!old) return null;
    if (!["pending", "complete"].includes(old.status) || old.expires_at <= now || (old.status === "pending" && old.pending_expires_at <= now)) throw new CreationArchiveError(409, "archive-closed", "この作品の保存は終了しました。");
    const saved = await env.EVALUATIONS_DB.prepare("SELECT asset_name,bytes,sha256,content_type FROM creation_archive_assets WHERE archive_id=?").bind(id).all<{ asset_name: Name; bytes: number; sha256: string; content_type: string }>();
    if (saved.results.length !== a.size || saved.results.some(x => { const requested = a.get(x.asset_name); return !requested || requested.bytes !== x.bytes || requested.sha256 !== x.sha256 || requested.contentType !== x.content_type; })) throw new CreationArchiveError(409, "archive-conflict", "同じ作品に異なる保存データが届きました。");
    return { ...result, pendingExpiresAt: old.pending_expires_at, expiresAt: old.expires_at };
  };
  const existing = await existingResult();
  if (existing) return existing;
  const s: Stmt[] = [
    env.EVALUATIONS_DB.prepare(
      "INSERT INTO creation_archives (archive_id,generation_id,consent_version,provenance,status,reserved_bytes,created_at,pending_expires_at,expires_at,delete_capability_hash,upload_capability_hash) VALUES (?,?,?,'model-verified','pending',?,?,?,?,?,?)",
    ).bind(
      id,
      input.generationId,
      input.consentVersion,
      total,
      now,
      now + CREATION_ARCHIVE_PENDING_MS,
      now + CREATION_ARCHIVE_RETENTION_MS,
      await hex(d),
      await hex(u),
    ),
  ];
  for (const x of a.values()) {
    const e =
      x.name === "candidate-a-json"
        ? expected.get("candidate-a")
        : x.name === "candidate-b-json"
          ? expected.get("candidate-b")
          : null;
    s.push(
      env.EVALUATIONS_DB.prepare(
        "INSERT INTO creation_archive_assets (archive_id,asset_name,r2_key,content_type,bytes,sha256,expected_content_sha256,uploaded_at) VALUES (?,?,?,?,?,?,?,0)",
      ).bind(id, x.name, rkey(id, x.name), x.contentType, x.bytes, x.sha256, e),
    );
  }
  try {
    await env.EVALUATIONS_DB.batch(s);
  } catch {
    const raced = await existingResult();
    if (raced) return raced;
    const quota = await env.EVALUATIONS_DB.prepare("SELECT reserved_bytes,used_bytes FROM creation_archive_quota WHERE singleton=1").first<{ reserved_bytes: number; used_bytes: number }>();
    if (quota && quota.reserved_bytes + quota.used_bytes + total > CREATION_ARCHIVE_QUOTA_BYTES) throw new CreationArchiveError(413, "archive-quota", "保存容量の上限に達しました。");
    throw new CreationArchiveError(503, "archive-storage-failed", "作品の保存を開始できませんでした。");
  }
  return result;
};
export const uploadCreationArchiveAsset = async (
  env: CreationArchiveEnv,
  id: string,
  n: string,
  c: string,
  t: string,
  h: string,
  b: ReadableStream<Uint8Array>,
  now = Date.now(),
) => {
  if (
    !UUID.test(id) ||
    !NAMES.includes(n as Name) ||
    !HEX.test(h) ||
    !await validCapability(env.EVALUATION_RECEIPT_SECRET, id, "upload", c)
  )
    throw new CreationArchiveError(
      403,
      "archive-upload-denied",
      "保存アップロードの期限が切れています。",
    );
  const started = Date.now(), clock = () => now + Date.now() - started;
  const token = crypto.randomUUID(), objectKey = `${rkey(id, n as Name)}/${token}`;
  let claimed = false;
  try {
    const x = await env.EVALUATIONS_DB.prepare(
      "SELECT bytes,sha256,content_type,r2_key,expected_content_sha256,uploaded_at FROM creation_archive_assets WHERE archive_id=? AND asset_name=? AND EXISTS(SELECT 1 FROM creation_archives WHERE archive_id=? AND status='pending' AND pending_expires_at>?)",
    )
      .bind(id, n, id, clock())
      .first<{
        bytes: number;
        sha256: string;
        content_type: string;
        r2_key: string;
        expected_content_sha256: string | null;
        uploaded_at: number;
      }>();
    if (!x || x.sha256 !== h || x.content_type !== t.toLowerCase())
      throw new CreationArchiveError(
        409,
        "archive-asset-mismatch",
        "保存データが予約内容と一致しません。",
      );
    if (x.uploaded_at > 0) { await b?.cancel().catch(() => undefined); return { uploaded: true }; }
    const data = await read(b, x.bytes);
    if (data.length !== x.bytes || (await hex(data)) !== x.sha256)
      throw new CreationArchiveError(
        409,
        "archive-asset-mismatch",
        "保存データが予約内容と一致しません。",
      );
    mime(n as Name, x.content_type, data);
    if (n === "manifest") {
      const value = JSON.parse(new TextDecoder().decode(data));
      const owner = await env.EVALUATIONS_DB.prepare("SELECT generation_id FROM creation_archives WHERE archive_id=?").bind(id).first<{generation_id:string}>();
      const keys = new Set(["schemaVersion", "generationId", "consentVersion", "createdAt", "buildId", "mode", "drawingAnalysis", "modelInfo", "lyricsPromptVersion", "displayOrder", "activeCandidateId", "drawingCanvas", "candidates", "assets"]);
      if (!value || value.schemaVersion !== 1 || value.generationId !== owner?.generation_id || value.consentVersion !== CREATION_ARCHIVE_CONSENT_VERSION || Object.keys(value).some(key => !keys.has(key))) {
        throw new CreationArchiveError(400, "invalid-manifest", "作品の保存情報が正しくありません。");
      }
    }
    if (x.expected_content_sha256) {
      let candidate: unknown;
      try {
        candidate = JSON.parse(new TextDecoder().decode(data));
      } catch {
        throw new CreationArchiveError(
          415,
          "invalid-asset-mime",
          "作品データの形式が正しくありません。",
        );
      }
      if ((await canonicalHash(candidate)) !== x.expected_content_sha256)
        throw new CreationArchiveError(
          409,
          "archive-candidate-mismatch",
          "保存データが署名済みの歌詞と一致しません。",
        );
    }
    const claimTime = clock();
    await env.EVALUATIONS_DB.batch([
      env.EVALUATIONS_DB.prepare("UPDATE creation_archive_assets SET upload_token=?,upload_expires_at=? WHERE archive_id=? AND asset_name=? AND uploaded_at=0 AND (upload_token IS NULL OR upload_expires_at<=?) AND EXISTS(SELECT 1 FROM creation_archives WHERE archive_id=? AND status='pending' AND pending_expires_at>?) AND (SELECT COUNT(*) FROM creation_archive_uploads WHERE archive_id=? AND asset_name=?)<3").bind(token,claimTime+300000,id,n,claimTime,id,claimTime,id,n),
      env.EVALUATIONS_DB.prepare("INSERT INTO creation_archive_uploads (archive_id,asset_name,token,r2_key,expires_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM creation_archive_assets WHERE archive_id=? AND asset_name=? AND upload_token=?)").bind(id,n,token,objectKey,claimTime+300000,id,n,token),
    ]);
    claimed = !!await env.EVALUATIONS_DB.prepare("SELECT token FROM creation_archive_uploads WHERE token=?").bind(token).first();
    if (!claimed) throw new CreationArchiveError(409,"upload-busy","保存中です。しばらくしてから確認してください。");
    const put = await env.CREATION_ARCHIVES.put(objectKey, data, {
      sha256: x.sha256,
      httpMetadata: { contentType: x.content_type },
    });
    if (!put || put.size !== data.byteLength) throw new CreationArchiveError(503,"archive-write-failed","作品を保存できませんでした。");
    const ok = await env.EVALUATIONS_DB.prepare(
      "UPDATE creation_archive_assets SET uploaded_at=?,r2_key=? WHERE archive_id=? AND asset_name=? AND upload_token=? AND upload_expires_at>? AND EXISTS(SELECT 1 FROM creation_archives WHERE archive_id=? AND status='pending' AND pending_expires_at>?)",
    )
      .bind(clock(), objectKey, id, n, token, clock(), id, clock())
      .run();
    if (!ok.meta?.changes) {
      await env.CREATION_ARCHIVES.delete(objectKey);
      throw new CreationArchiveError(409,"archive-closed","この作品の保存は終了しました。");
    }
    return { uploaded: !!ok.meta?.changes };
  } finally {
    if (claimed) await env.EVALUATIONS_DB.prepare(
      "UPDATE creation_archive_assets SET upload_token=NULL,upload_expires_at=NULL WHERE archive_id=? AND asset_name=? AND upload_token=?",
    )
      .bind(id, n, token)
      .run();
  }
};
export const completeCreationArchive = async (
  env: CreationArchiveEnv,
  id: string,
  c: string,
  m: string,
  now = Date.now(),
) => {
  if (
    !HEX.test(m) ||
    !await validCapability(env.EVALUATION_RECEIPT_SECRET, id, "upload", c)
  )
    throw new CreationArchiveError(
      403,
      "archive-complete-denied",
      "保存の期限が切れています。",
    );
  const r = await env.EVALUATIONS_DB.prepare(
    "SELECT reserved_bytes,status,manifest_hash FROM creation_archives WHERE archive_id=? AND expires_at>?",
  )
    .bind(id, now)
    .first<{ reserved_bytes: number; status: string; manifest_hash: string | null }>();
  if (r?.status === "complete" && r.manifest_hash === m) return { status: "complete" as const };
  if (!r)
    throw new CreationArchiveError(
      409,
      "archive-incomplete",
      "必要な作品データがありません。",
    );
  if (
    !(
      await env.EVALUATIONS_DB.prepare(
        "UPDATE creation_archives SET status='complete',uploaded_bytes=reserved_bytes,reserved_bytes=0,manifest_hash=? WHERE archive_id=? AND status='pending' AND pending_expires_at>? AND NOT EXISTS(SELECT 1 FROM creation_archive_assets WHERE archive_id=? AND upload_token IS NOT NULL AND upload_expires_at>?) AND EXISTS(SELECT 1 FROM creation_archive_assets WHERE archive_id=? AND asset_name='manifest' AND sha256=? AND uploaded_at>0) AND (SELECT COUNT(*) FROM creation_archive_assets WHERE archive_id=? AND uploaded_at>0)=(SELECT COUNT(*) FROM creation_archive_assets WHERE archive_id=?)",
      )
        .bind(m, id, now, id, now, id, m, id, id)
        .run()
    ).meta?.changes
  )
    throw new CreationArchiveError(
      409,
      "archive-incomplete",
      "必要な作品データがありません。",
    );
  return { status: "complete" as const };
};
export const getCreationArchiveStatus = async (
  env: CreationArchiveEnv,
  id: string,
  c: string,
) => {
  if (!await validCapability(env.EVALUATION_RECEIPT_SECRET, id, "delete", c))
    throw new CreationArchiveError(
      404,
      "archive-not-found",
      "作品保存が見つかりません。",
    );
  const r = await env.EVALUATIONS_DB.prepare(
    "SELECT status,expires_at FROM creation_archives WHERE archive_id=?",
  )
    .bind(id)
    .first<{ status: string; expires_at: number }>();
  if (!r)
    throw new CreationArchiveError(
      404,
      "archive-not-found",
      "作品保存が見つかりません。",
    );
  return { status: r.status, expiresAt: r.expires_at };
};
export const deleteCreationArchive = async (
  env: CreationArchiveEnv,
  id: string,
  c: string,
  now = Date.now(),
) => {
  if (!await validCapability(env.EVALUATION_RECEIPT_SECRET, id, "delete", c))
    throw new CreationArchiveError(
      404,
      "archive-not-found",
      "作品保存が見つかりません。",
    );
  const r = await env.EVALUATIONS_DB.prepare(
    "SELECT status,reserved_bytes,uploaded_bytes FROM creation_archives WHERE archive_id=?",
  )
    .bind(id)
    .first<{
      status: string;
      reserved_bytes: number;
      uploaded_bytes: number;
    }>();
  if (!r)
    throw new CreationArchiveError(
      404,
      "archive-not-found",
      "作品保存が見つかりません。",
    );
  // Keep every attempted key for late-write cleanup. A repeated delete sweeps
  // those exact keys again; it never releases another record's reservation.
  await env.EVALUATIONS_DB.prepare(
    "UPDATE creation_archives SET status='deleting' WHERE archive_id=? AND status!='deleted'",
  )
    .bind(id)
    .run();
  const a = await env.EVALUATIONS_DB.prepare(
    "SELECT r2_key FROM creation_archive_assets WHERE archive_id=? UNION SELECT r2_key FROM creation_archive_uploads WHERE archive_id=?",
  )
    .bind(id, id)
    .all<{ r2_key: string }>();
  await env.CREATION_ARCHIVES.delete(a.results.map((x) => x.r2_key));
  await env.EVALUATIONS_DB.batch([
    env.EVALUATIONS_DB.prepare("UPDATE creation_archives SET status='deleted',deleted_at=?,reserved_bytes=0,uploaded_bytes=0 WHERE archive_id=? AND status='deleting' AND NOT EXISTS(SELECT 1 FROM creation_archive_assets WHERE archive_id=? AND upload_token IS NOT NULL AND upload_expires_at>?)").bind(now,id,id,now),
    env.EVALUATIONS_DB.prepare("DELETE FROM evaluation_records WHERE generation_id=(SELECT generation_id FROM creation_archives WHERE archive_id=? AND status IN ('deleting','deleted'))").bind(id),
  ]);
  const state = await env.EVALUATIONS_DB.prepare("SELECT status FROM creation_archives WHERE archive_id=?").bind(id).first<{status:string}>();
  return { deleted: state?.status === "deleted", status: state?.status };
};
export const cleanupCreationArchives = async (
  env: CreationArchiveEnv,
  now = Date.now(),
  limit = 50,
) => {
  limit = Math.max(1, Math.min(50, Math.trunc(limit) || 50));
  const a = await env.EVALUATIONS_DB.prepare(
    "SELECT archive_id FROM creation_archives WHERE (status='pending' AND pending_expires_at<=?) OR (status='complete' AND expires_at<=?) OR status='deleting' OR (status='deleted' AND deleted_at>?) ORDER BY CASE WHEN status='deleted' THEN 1 ELSE 0 END, COALESCE(deleted_at,created_at) LIMIT ?",
  )
    .bind(now, now, now-86400000, limit)
    .all<{ archive_id: string }>();
  for (const r of a.results)
    await deleteCreationArchive(
      env,
      r.archive_id,
      await cap(env.EVALUATION_RECEIPT_SECRET, r.archive_id, "delete"),
      now,
    );
  return { scanned: a.results.length };
};
