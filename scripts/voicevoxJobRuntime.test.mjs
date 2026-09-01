import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const wav = new Uint8Array(46), view = new DataView(wav.buffer);
wav.set(new TextEncoder().encode("RIFF")); view.setUint32(4, 38, true);
wav.set(new TextEncoder().encode("WAVEfmt "), 8); view.setUint32(16, 16, true);
view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true);
view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
wav.set(new TextEncoder().encode("data"), 36); view.setUint32(40, 2, true);
const sql = (await Promise.all(["0003_voicevox_grants.sql", "0004_voicevox_jobs.sql", "0005_voicevox_job_dispatch.sql"].map(name => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")))).join("\n").replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean);
const bundled = await build({ write: false, bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["cloudflare:workers"], stdin: { resolveDir: root, loader: "ts", contents: `
import { handleVoicevoxJobApi, createVoicevoxJobCapability } from './src/voicevoxJobApi';
import { consumeVoicevoxJob } from './src/voicevoxJobConsumer';
export { VoicevoxBackendPool } from './src/voicevoxBackendPool';
const statements=${JSON.stringify(sql)}, wav=new Uint8Array(${JSON.stringify([...wav])});
const sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),v=>v.toString(16).padStart(2,'0')).join('');
export default { async fetch(request,env){
 const path=new URL(request.url).pathname;
 env.VOICEVOX_JOBS={send:async()=>{}};
 if(path==='/seed'){
  if(new URL(request.url).searchParams.has('init'))for(const sql of statements)await env.EVALUATIONS_DB.prepare(sql).run();
  const generationId=crypto.randomUUID(), now=Date.now();
  const candidates=await Promise.all(['candidate-a','candidate-b'].map(async candidateId=>{
   const voiceGrant=crypto.randomUUID();await env.EVALUATIONS_DB.prepare('INSERT INTO voicevox_grants (grant_hash,generation_id,candidate_id,issued_at,expires_at) VALUES (?,?,?,?,?)').bind(await sha(voiceGrant),generationId,candidateId,now,now+300000).run();
   return {candidateId,voiceGrant,score:{notes:[{lyric:'あ',key:60,frame_length:20}]}};
  }));return Response.json({generationId,groupId:generationId,candidates,capability:await createVoicevoxJobCapability(generationId,env.EVALUATION_RECEIPT_SECRET)});
 }
 if(path==='/consume'){
  let calls=0;const failure=request.headers.get('X-Test-Fail')==='true';
  env.VOICEVOX={fetch:async(url)=>{calls++;return failure?new Response('unavailable',{status:503}):String(url).includes('sing_frame_audio_query')?Response.json({outputSamplingRate:24000}):new Response(wav)}};
  const outcome=await consumeVoicevoxJob(await request.json(),env);return Response.json({outcome,calls});
 }
 return handleVoicevoxJobApi(request,env);
} }` } });

test("Workers runtime: D1 registration -> actual DO lease -> mock VPC -> private R2 -> authenticated audio", async t => {
 const mf = new Miniflare({ host: "127.0.0.1", port: 0, workers: [{ config: { name: "jobs-test", type: "worker", compatibilityDate: "2026-08-31", manifest: { mainModule: "worker.mjs", modules: { "worker.mjs": { type: "esm", contents: bundled.outputFiles[0].text } } }, env: {
  EVALUATIONS_DB: { type: "d1", name: "jobs-test" }, TEMPORARY_AUDIO: { type: "r2", name: "audio-test" }, EVALUATION_RECEIPT_SECRET: { type: "text", value: "test-only-secret-not-production-0000" }, VPC_CAPACITY: { type: "text", value: "1" }, CLOUD_RUN_CAPACITY: { type: "text", value: "1" }, VOICEVOX_BACKEND_POOL: { type: "durable-object", workerName: "jobs-test", exportName: "VoicevoxBackendPool" },
 }, exports: { VoicevoxBackendPool: { type: "durable-object", storage: "sqlite" } } } }] });
 t.after(() => mf.dispose());
 const seed = await (await mf.dispatchFetch("https://app.test/seed?init")).json();
 const headers={Origin:"https://app.test","Content-Type":"application/json","X-Voicevox-Capability":seed.capability};
 const register=()=>mf.dispatchFetch("https://app.test/api/voicevox/jobs/register",{method:"POST",headers,body:JSON.stringify(seed)});
 const first=await register();assert.equal(first.status,202,await first.clone().text());
 const registered=await first.json(); const replay=await register();assert.equal(replay.status,202);assert.equal((await replay.json()).duplicate,true);
 for(const job of registered.jobs){
  const message={schemaVersion:1,jobId:job.jobId,generationId:seed.generationId,candidateId:job.candidateId};
  const consume=()=>mf.dispatchFetch("https://app.test/consume",{method:"POST",body:JSON.stringify(message)});
  assert.deepEqual(await (await consume()).json(),{outcome:"ack",calls:2});
  assert.deepEqual(await (await consume()).json(),{outcome:"ack",calls:0});
  const url=`https://app.test/api/voicevox/jobs/${encodeURIComponent(job.jobId)}`;
  const state=await (await mf.dispatchFetch(url,{headers:{"X-Voicevox-Capability":seed.capability}})).json();assert.equal(state.status,"succeeded");
  const audio=await mf.dispatchFetch(url+"/audio",{headers:{"X-Voicevox-Capability":seed.capability}});assert.equal(audio.status,200);assert.equal(audio.headers.get("Cache-Control"),"private, no-store");assert.deepEqual(new Uint8Array(await audio.arrayBuffer()),wav);
  assert.equal((await mf.dispatchFetch(url+"/audio")).status,404);
 }
 const denied=await mf.dispatchFetch("https://app.test/api/voicevox/jobs/register",{method:"POST",headers:{"Content-Type":"application/json","X-Voicevox-Capability":seed.capability},body:JSON.stringify(seed)});assert.equal(denied.status,403);
 const retrySeed=await (await mf.dispatchFetch("https://app.test/seed")).json();
 const retryHeaders={...headers,"X-Voicevox-Capability":retrySeed.capability};
 const retryRegistration=await (await mf.dispatchFetch("https://app.test/api/voicevox/jobs/register",{method:"POST",headers:retryHeaders,body:JSON.stringify(retrySeed)})).json();
 const [retryJob,cancelJob]=retryRegistration.jobs;
 const retryMessage={schemaVersion:1,jobId:retryJob.jobId,generationId:retrySeed.generationId,candidateId:retryJob.candidateId};
 assert.deepEqual(await (await mf.dispatchFetch("https://app.test/consume",{method:"POST",headers:{"X-Test-Fail":"true"},body:JSON.stringify(retryMessage)})).json(),{outcome:"retry",calls:1});
 assert.deepEqual(await (await mf.dispatchFetch("https://app.test/consume",{method:"POST",body:JSON.stringify(retryMessage)})).json(),{outcome:"ack",calls:2});
 const cancelUrl=`https://app.test/api/voicevox/jobs/${encodeURIComponent(cancelJob.jobId)}`;
 assert.equal((await mf.dispatchFetch(cancelUrl+"/cancel",{method:"POST",headers:retryHeaders})).status,202);
 assert.deepEqual(await (await mf.dispatchFetch("https://app.test/consume",{method:"POST",body:JSON.stringify({...retryMessage,jobId:cancelJob.jobId,candidateId:cancelJob.candidateId})})).json(),{outcome:"ack",calls:0});
 assert.equal((await (await mf.dispatchFetch(cancelUrl,{headers:retryHeaders})).json()).status,"cancelled");
});
