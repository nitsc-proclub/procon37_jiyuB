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
const sql = (await Promise.all(["0003_voicevox_grants.sql", "0004_voicevox_jobs.sql", "0005_voicevox_job_dispatch.sql", "0007_voicevox_group_backend.sql"].map(name => readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")))).join("\n").replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean);
const bundled = await build({ write: false, bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["cloudflare:workers"], stdin: { resolveDir: root, loader: "ts", contents: `
import { handleVoicevoxJobApi, createVoicevoxJobCapability } from './src/voicevoxJobApi';
import { consumeVoicevoxJob, voicevoxPoolRpcFromService } from './src/voicevoxJobConsumer';
export { VoicevoxBackendPool } from './src/voicevoxBackendPool';
const statements=${JSON.stringify(sql)}, wav=new Uint8Array(${JSON.stringify([...wav])});
const sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),v=>v.toString(16).padStart(2,'0')).join(''); const sent=[];
export default { async fetch(request,env){
 const path=new URL(request.url).pathname;
 env.VOICEVOX_JOB_QUEUES={vpc:{send:async m=>{sent.push({backend:'vpc',...m})}},'cloud-run':{send:async m=>{sent.push({backend:'cloud-run',...m})}}};
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
  const directPool={acquire:r=>env.VOICEVOX_BACKEND_POOL.getByName('voicevox-backend-pool:v1:'+r.backend).acquire(r),release:r=>env.VOICEVOX_BACKEND_POOL.getByName('voicevox-backend-pool:v1:'+r.backend).release(r)};
  const service={acquireBackendLease:directPool.acquire,releaseBackendLease:directPool.release};
  const pool=new URL(request.url).searchParams.has('service')?voicevoxPoolRpcFromService(service):directPool;
  const outcome=await consumeVoicevoxJob(await request.json(),{...env,VOICEVOX_BACKEND_POOL:pool});return Response.json({outcome,calls});
 }
 if(path==='/routes')return Response.json({groups:(await env.EVALUATIONS_DB.prepare('SELECT generation_id,preferred_backend FROM voicevox_job_groups ORDER BY created_at,generation_id').all()).results,sent});
 return handleVoicevoxJobApi(request,env);
} }` } });

test("Workers runtime: D1 registration -> actual DO lease -> mock VPC -> private R2 -> authenticated audio", async t => {
 const mf = new Miniflare({ host: "127.0.0.1", port: 0, workers: [{ config: { name: "jobs-test", type: "worker", compatibilityDate: "2026-08-31", manifest: { mainModule: "worker.mjs", modules: { "worker.mjs": { type: "esm", contents: bundled.outputFiles[0].text } } }, env: {
  EVALUATIONS_DB: { type: "d1", name: "jobs-test" }, TEMPORARY_AUDIO: { type: "r2", name: "audio-test" }, EVALUATION_RECEIPT_SECRET: { type: "text", value: "test-only-secret-not-production-0000" }, VPC_CAPACITY: { type: "text", value: "1" }, CLOUD_RUN_CAPACITY: { type: "text", value: "1" }, VOICEVOX_BACKEND_POOL: { type: "durable-object", worker: "jobs-test", exportName: "VoicevoxBackendPool" },
 }, exports: { VoicevoxBackendPool: { type: "durable-object", storage: "sqlite" } } } }] });
 t.after(() => mf.dispose());
 const seed = await (await mf.dispatchFetch("https://app.test/seed?init")).json();
 const headers={Origin:"https://app.test","Content-Type":"application/json","X-Voicevox-Capability":seed.capability};
 const register=()=>mf.dispatchFetch("https://app.test/api/voicevox/jobs/register",{method:"POST",headers,body:JSON.stringify(seed)});
 const first=await register();assert.equal(first.status,202,await first.clone().text());
 const registered=await first.json(); const replay=await register();assert.equal(replay.status,202);assert.equal((await replay.json()).duplicate,true);
 for(const job of registered.jobs){
  const message={schemaVersion:1,jobId:job.jobId,generationId:seed.generationId,candidateId:job.candidateId};
  const consume=()=>mf.dispatchFetch(`https://app.test/consume${job===registered.jobs[0]?"?service=1":""}`,{method:"POST",body:JSON.stringify(message)});
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
 // With the configured threshold of two *other* active generations, the
 // first two remain VPC and the third is atomically fixed to Cloud Run. The
 // captured producer messages prove backend-specific dispatch before consume.
 const overflow=[];
 for(let i=0;i<3;i++){const entry=await (await mf.dispatchFetch("https://app.test/seed")).json();const response=await mf.dispatchFetch("https://app.test/api/voicevox/jobs/register",{method:"POST",headers:{Origin:"https://app.test","Content-Type":"application/json","X-Voicevox-Capability":entry.capability},body:JSON.stringify(entry)});assert.equal(response.status,202);overflow.push(entry.generationId);}
 const routed=await (await mf.dispatchFetch("https://app.test/routes")).json();const selected=Object.fromEntries(routed.groups.filter(g=>overflow.includes(g.generation_id)).map(g=>[g.generation_id,g.preferred_backend]));assert.deepEqual(selected,{[overflow[0]]:"vpc",[overflow[1]]:"vpc",[overflow[2]]:"cloud-run"});assert.deepEqual(routed.sent.filter(m=>overflow.includes(m.generationId)).map(m=>m.backend),["vpc","vpc","vpc","vpc","cloud-run","cloud-run"]);
});
