import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const splitSql = (source) => {
  const text = source.replace(/--[^\n]*/g, "");
  const triggers = [...text.matchAll(/CREATE TRIGGER[\s\S]*?END;/g)].map(
    (match) => match[0],
  );
  const ordinary = text
    .replace(/CREATE TRIGGER[\s\S]*?END;/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...ordinary, ...triggers];
};
const migrations = splitSql(
  (
    await Promise.all(
      [
        "0001_evaluation_records.sql",
        "0002_evaluation_followups.sql",
        "0006_creation_archives.sql",
      ].map((n) =>
        readFile(new URL(`../migrations/${n}`, import.meta.url), "utf8"),
      ),
    )
  ).join("\n"),
);
const bundle = await build({
  write: false,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  stdin: {
    resolveDir: root,
    loader: "ts",
    contents: `
import { handleCreationArchiveRequest } from './src/creationArchiveApi';
import { createEvaluationReceipt, evaluationFingerprint } from './services/evaluationSubmissionService';
import { issueArchiveGenerationTicket } from './src/creationArchiveTicket';
const sql=${JSON.stringify(migrations)}, E=new TextEncoder();
const hex=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof v==='string'?E.encode(v):v)),x=>x.toString(16).padStart(2,'0')).join('');
const candidate=(id,g)=>({candidateId:id,title:'まる',lines:['まる'],singingKanaLines:['まる'],identifiedObject:'りんご',lineStrokeMappings:[{lineIndex:0,strokeGroupIds:[g]}],modelName:'gemini'});
const png=new Uint8Array([137,80,78,71,13,10,26,10]);
export default {async fetch(request,env){const url=new URL(request.url);if(url.pathname==='/seed'){for(const q of sql)await env.EVALUATIONS_DB.prepare(q).run();const single=url.searchParams.get('single')==='true', image=single?new Uint8Array([255,216,255,217]):png, generationId=crypto.randomUUID(), candidates=[candidate('candidate-a','g1'),candidate('candidate-b','g2')].slice(0,single?1:2), evaluation={schemaVersion:1,generationId,evaluationReceipt:'',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',consentedAt:'2026-01-01T00:00:00.000Z',buildId:'test',experimentRoundId:null,drawingAnalysisSchemaVersion:1,lyricsPromptVersion:null,firstImpressionSelection:single?null:'candidate-a',displayOrder:candidates.map(c=>c.candidateId),candidates,strokeGroupIds:['g1','g2'],drawingAnalysis:single?null:{schemaVersion:1,objectCandidates:[{label:'りんご',confidence:'high'}],parts:[{id:'p',shape:'丸',position:'中央',strokeGroupIds:['g1']}],drawingOrder:['p']},modelInfo:{drawingAnalysis:'model',lyricsGeneration:'model'},activeCandidateId:'candidate-a',alternativePreviewed:false,centralConsent:'accepted'};const receipt=await createEvaluationReceipt(generationId,evaluation,env.EVALUATION_RECEIPT_SECRET,Date.now(),3600);evaluation.evaluationReceipt=receipt.value;const fp=await evaluationFingerprint(evaluation),drawing=JSON.stringify({strokes:[],strokeGroups:[]}), assetData={'input-image':image,'drawing-json':E.encode(drawing),'candidate-a-json':E.encode(JSON.stringify(candidates[0])),...(single?{}:{'candidate-b-json':E.encode(JSON.stringify(candidates[1]))}),'manifest':E.encode(JSON.stringify({schemaVersion:1,generationId,consentVersion:'creation-archive-v1'}))};const assets=await Promise.all(Object.entries(assetData).map(async([name,data])=>({name,bytes:data.length,sha256:await hex(data),contentType:name==='input-image'?(single?'image/jpeg':'image/png'):'application/json'})));const ticket=await issueArchiveGenerationTicket({generationId,evaluationFingerprint:fp,candidateSha256:await hex(fp),imageSha256:await hex(image),analysisSha256:await hex(drawing)},env.EVALUATION_RECEIPT_SECRET);await env.EVALUATIONS_DB.prepare("INSERT INTO evaluation_records (generation_id,payload_hash,created_at,updated_at,status,central_consent,evaluation_json) VALUES (?,?,'t','t','pending','accepted','{}')").bind(generationId,'h').run();return Response.json({body:{generationId,evaluation,consentVersion:'creation-archive-v1',generationTicket:ticket.value,assets},assetData:Object.fromEntries(Object.entries(assetData).map(([k,v])=>[k,Array.from(v)]))});}if(url.pathname==='/inspect'){const id=url.searchParams.get('id');return Response.json({archive:id?await env.EVALUATIONS_DB.prepare('SELECT status,reserved_bytes,uploaded_bytes FROM creation_archives WHERE archive_id=?').bind(id).first():null,quota:await env.EVALUATIONS_DB.prepare('SELECT reserved_bytes,used_bytes FROM creation_archive_quota WHERE singleton=1').first(),evaluations:await env.EVALUATIONS_DB.prepare('SELECT COUNT(*) AS count FROM evaluation_records').first()});}if(url.pathname==='/quota'){await env.EVALUATIONS_DB.prepare('UPDATE creation_archive_quota SET used_bytes=? WHERE singleton=1').bind(Number(url.searchParams.get('used'))).run();return new Response('ok')}if(url.pathname==='/late'){try{await env.EVALUATIONS_DB.prepare("INSERT INTO evaluation_records (generation_id,payload_hash,created_at,updated_at,status,central_consent,evaluation_json) VALUES (?,?,'t','t','pending','accepted','{}')").bind(url.searchParams.get('generationId'),'late').run();return new Response('unexpected')}catch{return new Response('rejected',{status:409})}}return handleCreationArchiveRequest(request,env)}}`,
  },
});

for (const single of [false, true]) test(`archive HTTP runtime (${single ? "single JPEG" : "A/B PNG"}): signed init, replay, upload, completion, deletion`, async (t) => {
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    workers: [
      {
        config: {
          name: "archive-test",
          type: "worker",
          compatibilityDate: "2026-08-31",
          manifest: {
            mainModule: "worker.mjs",
            modules: {
              "worker.mjs": {
                type: "esm",
                contents: bundle.outputFiles[0].text,
              },
            },
          },
          env: {
            EVALUATIONS_DB: { type: "d1", name: "archive-db" },
            CREATION_ARCHIVES: { type: "r2", name: "archive-r2" },
            EVALUATION_RECEIPT_SECRET: {
              type: "text",
              value: "test-only-secret-not-production-0000",
            },
          },
        },
      },
    ],
  });
  t.after(() => mf.dispose());
  const seed = await (await mf.dispatchFetch(`https://app.test/seed?single=${single}`)).json(),
    init = () =>
      mf.dispatchFetch("https://app.test/api/creation-archives", {
        method: "POST",
        headers: {
          Origin: "https://app.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(seed.body),
      });
  const first = await init();
  assert.equal(first.status, 201, await first.clone().text());
  const created = await first.json();
  const replay = await init();
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).archiveId, created.archiveId);
  const conflicting = structuredClone(seed.body);
  conflicting.assets.find((asset) => asset.name === "manifest").sha256 =
    "0".repeat(64);
  const conflict = await mf.dispatchFetch(
    "https://app.test/api/creation-archives",
    {
      method: "POST",
      headers: {
        Origin: "https://app.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(conflicting),
    },
  );
  assert.equal(conflict.status, 409);
  const incomplete = await mf.dispatchFetch(
    `https://app.test/api/creation-archives/${created.archiveId}`,
    {
      method: "POST",
      headers: {
        Origin: "https://app.test",
        Authorization: `Bearer ${created.uploadCapability}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        manifestSha256: seed.body.assets.find(
          (asset) => asset.name === "manifest",
        ).sha256,
      }),
    },
  );
  assert.equal(incomplete.status, 409);
  for (const d of seed.body.assets) {
    const response = await mf.dispatchFetch(
      `https://app.test/api/creation-archives/${created.archiveId}/assets/${d.name}`,
      {
        method: "PUT",
        headers: {
          Origin: "https://app.test",
          Authorization: `Bearer ${created.uploadCapability}`,
          "Content-Type": d.contentType,
          "X-Content-SHA256": d.sha256,
        },
        body: new Uint8Array(seed.assetData[d.name]),
      },
    );
    assert.equal(response.status, 200, await response.text());
  }
  const complete = await mf.dispatchFetch(
    `https://app.test/api/creation-archives/${created.archiveId}`,
    {
      method: "POST",
      headers: {
        Origin: "https://app.test",
        Authorization: `Bearer ${created.uploadCapability}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        manifestSha256: seed.body.assets.find((x) => x.name === "manifest")
          .sha256,
      }),
    },
  );
  assert.equal(complete.status, 200, await complete.text());
  const bad = await mf.dispatchFetch(
    `https://app.test/api/creation-archives/${created.archiveId}`,
    { headers: { Authorization: "Bearer bad" } },
  );
  assert.equal(bad.status, 403);
  const beforeDelete = await (
    await mf.dispatchFetch(`https://app.test/inspect?id=${created.archiveId}`)
  ).json();
  assert.equal(beforeDelete.evaluations.count, 1);
  const del = () =>
    mf.dispatchFetch(
      `https://app.test/api/creation-archives/${created.archiveId}`,
      {
        method: "DELETE",
        headers: {
          Origin: "https://app.test",
          Authorization: `Bearer ${created.deleteCapability}`,
        },
      },
    );
  assert.equal((await del()).status, 200);
  assert.equal((await del()).status, 200);
  const inspected = await (
    await mf.dispatchFetch(`https://app.test/inspect?id=${created.archiveId}`)
  ).json();
  assert.equal(inspected.archive.status, "deleted");
  assert.equal(inspected.evaluations.count, 0);
  await mf.dispatchFetch("https://app.test/quota?used=7999999999");
  const overflowSeed = await (
    await mf.dispatchFetch("https://app.test/seed")
  ).json();
  const overflow = await mf.dispatchFetch(
    "https://app.test/api/creation-archives",
    {
      method: "POST",
      headers: {
        Origin: "https://app.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(overflowSeed.body),
    },
  );
  assert.equal(overflow.status, 413);
  const afterOverflow = await (
    await mf.dispatchFetch("https://app.test/inspect")
  ).json();
  assert.equal(afterOverflow.quota.reserved_bytes, 0);
  assert.equal(afterOverflow.quota.used_bytes, 7999999999);
});
