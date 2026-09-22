import {
  evaluationFingerprint,
  EvaluationSubmissionError,
  validateEvaluationSubmission,
  verifyEvaluationReceipt,
} from "../services/evaluationSubmissionService";
import {
  completeCreationArchive,
  CreationArchiveError,
  deleteCreationArchive,
  getCreationArchiveStatus,
  initializeCreationArchive,
  uploadCreationArchiveAsset,
  type CreationArchiveEnv,
} from "./creationArchive";
export { cleanupCreationArchives } from "./creationArchive";
import { verifyArchiveGenerationTicket } from "./creationArchiveTicket";
const E = new TextEncoder(),
  MAX = 256 * 1024,
  HEX = /^[a-f0-9]{64}$/;
const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
const same = (r: Request) => r.headers.get("Origin") === new URL(r.url).origin;
const bounded = async (b: ReadableStream<Uint8Array> | null) => {
  if (!b)
    throw new CreationArchiveError(
      400,
      "missing-body",
      "リクエストが正しくありません。",
    );
  const q = b.getReader(),
    a: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const x = await q.read();
      if (x.done) break;
      n += x.value.length;
      if (n > MAX) {
        await q.cancel();
        throw new CreationArchiveError(
          413,
          "request-too-large",
          "リクエストが大きすぎます。",
        );
      }
      a.push(x.value);
    }
  } finally {
    q.releaseLock();
  }
  const o = new Uint8Array(n);
  let p = 0;
  for (const x of a) {
    o.set(x, p);
    p += x.length;
  }
  return o;
};
const body = async (r: Request) => {
  if (
    !r.headers.get("content-type")?.toLowerCase().includes("application/json")
  )
    throw new CreationArchiveError(
      415,
      "invalid-content-type",
      "JSONを指定してください。",
    );
  try {
    const value: unknown = JSON.parse(
      new TextDecoder().decode(await bounded(r.body)),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new CreationArchiveError(400, "invalid-json", "リクエストが正しくありません。");
    }
    return value as Record<string, unknown>;
  } catch (e) {
    if (e instanceof CreationArchiveError) throw e;
    throw new CreationArchiveError(
      400,
      "invalid-json",
      "リクエストが正しくありません。",
    );
  }
};
const bearer = (r: Request) => {
  const x = r.headers
    .get("Authorization")
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!x)
    throw new CreationArchiveError(
      403,
      "missing-capability",
      "保存用の権限を確認できません。",
    );
  return x[1];
};
const sha = async (v: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", E.encode(v))),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
/** Route adapter. The main Worker is responsible for feature gating and route registration. */
export const handleCreationArchiveRequest = async (
  r: Request,
  env: CreationArchiveEnv,
): Promise<Response> => {
  try {
    const u = new URL(r.url),
      p = u.pathname.split("/").filter(Boolean),
      mutate = r.method !== "GET";
    if (
      (mutate && !same(r)) ||
      (!mutate && r.headers.has("Origin") && !same(r)) ||
      r.headers.get("Sec-Fetch-Site") === "cross-site"
    )
      throw new CreationArchiveError(
        403,
        "invalid-origin",
        "同じサイトからのみ保存できます。",
      );
    if (p.length === 2 && r.method === "POST") {
      const v = await body(r),
        e = validateEvaluationSubmission(v.evaluation);
      if (
        v.generationId !== e.generationId ||
        !(await verifyEvaluationReceipt(
          e.evaluationReceipt,
          e.generationId,
          e,
          env.EVALUATION_RECEIPT_SECRET,
        ))
      )
        throw new CreationArchiveError(
          403,
          "invalid-evaluation-receipt",
          "評価保存の確認に失敗しました。",
        );
      const t =
        typeof v.generationTicket === "string"
          ? await verifyArchiveGenerationTicket(
              v.generationTicket,
              env.EVALUATION_RECEIPT_SECRET,
            )
          : null;
      if (
        !t ||
        t.generationId !== e.generationId ||
        t.evaluationFingerprint !== (await evaluationFingerprint(e)) ||
        t.candidateSha256 !== (await sha(t.evaluationFingerprint))
      )
        throw new CreationArchiveError(
          403,
          "invalid-archive-ticket",
          "保存用チケットを確認できません。",
        );
      const a: Array<Record<string, unknown>> = Array.isArray(v.assets)
          ? v.assets
          : [],
        find = (n: string) => a.find((x) => x.name === n)?.sha256;
      if (
        find("drawing-json") !== t.analysisSha256 ||
        (t.imageSha256 !== undefined && find("input-image") !== t.imageSha256)
      )
        throw new CreationArchiveError(
          403,
          "invalid-archive-ticket",
          "保存用チケットを確認できません。",
        );
      return json(
        await initializeCreationArchive(env, {
          generationId: e.generationId,
          consentVersion: String(v.consentVersion ?? ""),
          generationTicket: String(v.generationTicket),
          assets: a,
          evaluation: e,
        }),
        201,
      );
    }
    if (p.length === 5 && p[3] === "assets" && r.method === "PUT")
      return json(
        await uploadCreationArchiveAsset(
          env,
          p[2],
          p[4],
          bearer(r),
          r.headers.get("Content-Type")?.toLowerCase() ?? "",
          r.headers.get("X-Content-SHA256") ?? "",
          r.body!,
          Date.now(),
        ),
      );
    if (p.length === 3 && r.method === "POST") {
      const v = await body(r);
      return json(
        await completeCreationArchive(
          env,
          p[2],
          bearer(r),
          String(v.manifestSha256),
          Date.now(),
        ),
      );
    }
    if (p.length === 3 && r.method === "GET")
      return json(await getCreationArchiveStatus(env, p[2], bearer(r)));
    if (p.length === 3 && r.method === "DELETE")
      return json(
        await deleteCreationArchive(env, p[2], bearer(r), Date.now()),
      );
    return json({ code: "not-found" }, 404);
  } catch (e) {
    if (e instanceof CreationArchiveError || e instanceof EvaluationSubmissionError)
      return json({ code: e.code, error: e.message }, e.status);
    return json(
      { code: "archive-failed", error: "作品を保存できませんでした。" },
      500,
    );
  }
};
