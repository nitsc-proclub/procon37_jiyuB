import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", optimizeDeps: { noDiscovery: true } });
const api = await vite.ssrLoadModule("/src/voicevoxJobApi.ts");
await vite.close();
const read = query => /^\s*(?:\/\*[\s\S]*?\*\/\s*)*SELECT\b/i.test(query);
class Statement { constructor(db, query, values=[]) { this.db=db; this.query=query; this.values=values; } bind(...values) { return new Statement(this.db,this.query,values); } async all(){return {success:true,results:this.db.prepare(this.query).all(...this.values),meta:{}};} execute(){const s=this.db.prepare(this.query);if(read(this.query))return {success:true,results:s.all(...this.values),meta:{}};const r=s.run(...this.values);return {success:true,results:[],meta:{changes:Number(r.changes)}};} }
class D1 { constructor(){this.db=new DatabaseSync(":memory:");this.db.exec("PRAGMA foreign_keys=ON");} async migrate(){for(const f of ["0003_voicevox_grants.sql","0004_voicevox_jobs.sql","0005_voicevox_job_dispatch.sql","0007_voicevox_group_backend.sql"])this.db.exec(await readFile(new URL("../migrations/"+f,import.meta.url),"utf8"));} prepare(q){return new Statement(this.db,q);} async batch(ss){this.db.exec("BEGIN");try{const r=ss.map(s=>s.execute());this.db.exec("COMMIT");return r;}catch(e){this.db.exec("ROLLBACK");throw e;}} }
class Bucket { constructor(){this.items=new Map();} async put(key,value){const bytes=value instanceof Uint8Array?value:new Uint8Array(value);this.items.set(key,{key,size:bytes.byteLength,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})});return {key,size:bytes.byteLength};} async get(key){return this.items.get(key)??null;} async delete(key){this.items.delete(key);} async list(){return {objects:[],truncated:false};} }
const sha = value => createHash("sha256").update(value).digest("hex");
const score = { notes:[{lyric:"あ",key:60,frame_length:20}] };
for (const ids of [["candidate-a"], ["candidate-a", "candidate-b"]]) test(`real SQLite public registration (${ids.length} candidates) is idempotent and capability protects status`, async () => {
  const db=new D1();await db.migrate();const bucket=new Bucket(), generationId=randomUUID(), now=Date.now(), secret="x".repeat(32), grants=ids.map(id=>({id,value:`grant-${id}`}));
  for(const grant of grants)db.db.prepare("INSERT INTO voicevox_grants (grant_hash,generation_id,candidate_id,issued_at,expires_at) VALUES (?,?,?,?,?)").run(sha(grant.value),generationId,grant.id,now-1,now+100000);
  const capability=await api.createVoicevoxJobCapability(generationId,secret,now,100000);
  const queue={send:async()=>{}};const env={EVALUATIONS_DB:db,TEMPORARY_AUDIO:bucket,EVALUATION_RECEIPT_SECRET:secret,VOICEVOX_JOB_QUEUES:{vpc:queue,"cloud-run":queue}};
  const input={groupId:randomUUID(),generationId,candidates:grants.map(grant=>({candidateId:grant.id,voiceGrant:grant.value,score}))};
  const request=()=>new Request("https://app.test/api/voicevox/jobs/register",{method:"POST",headers:{Origin:"https://app.test","Content-Type":"application/json","X-Voicevox-Capability":capability},body:JSON.stringify(input)});
  const first=await api.handleVoicevoxJobApi(request(),env), second=await api.handleVoicevoxJobApi(request(),env);
  assert.equal(first.status,202);assert.equal(second.status,202);assert.equal((await second.json()).duplicate,true);
  assert.deepEqual((await first.json()).jobs.map(job => job.backend), ids.map(() => "vpc"));
  const jobId=encodeURIComponent(`${generationId}:candidate-a`);
  const denied=await api.handleVoicevoxJobApi(new Request(`https://app.test/api/voicevox/jobs/${jobId}`,{headers:{"X-Voicevox-Capability":"wrong","Sec-Fetch-Site":"same-origin"}}),env);assert.equal(denied.status,404);
  const allowed=await api.handleVoicevoxJobApi(new Request(`https://app.test/api/voicevox/jobs/${jobId}`,{headers:{"X-Voicevox-Capability":capability,"Sec-Fetch-Site":"same-origin"}}),env);assert.equal(allowed.status,200);const state=await allowed.json();assert.equal(state.status,"accepted");assert.equal(state.backend,"vpc");
  const foreign=await api.handleVoicevoxJobApi(new Request(`https://app.test/api/voicevox/jobs/${jobId}`,{headers:{Origin:"https://evil.test","X-Voicevox-Capability":capability}}),env);assert.equal(foreign.status,403);
});

for (const candidateCount of [1, 2]) test(`API routes explicit choices and reports actual auto overflow (${candidateCount} candidates)`, async () => {
  const db = new D1(); await db.migrate();
  const secret = "x".repeat(32), deliveries = [];
  const env = { EVALUATIONS_DB: db, TEMPORARY_AUDIO: new Bucket(), EVALUATION_RECEIPT_SECRET: secret,
    VOICEVOX_JOB_QUEUES: Object.fromEntries(["vpc", "cloud-run"].map(backend => [backend, { send: async message => deliveries.push({ backend, ...message }) }])) };
  const inputs = [];
  for (const [index, backendPreference] of [undefined, "auto", "vpc", "auto", "cloud-run"].entries()) {
    const generationId = randomUUID(), now = Date.now();
    const candidates = ["candidate-a", "candidate-b"].slice(0, candidateCount).map(candidateId => ({ candidateId, voiceGrant: randomUUID(), score }));
    for (const candidate of candidates) db.db.prepare("INSERT INTO voicevox_grants (grant_hash,generation_id,candidate_id,issued_at,expires_at) VALUES (?,?,?,?,?)").run(sha(candidate.voiceGrant), generationId, candidate.candidateId, now - 1, now + 100000);
    const capability = await api.createVoicevoxJobCapability(generationId, secret, now, 100000);
    const input = { groupId: generationId, generationId, candidates, backendPreference };
    const headers = { Origin: "https://app.test", "Content-Type": "application/json", "X-Voicevox-Capability": capability };
    const response = await api.handleVoicevoxJobApi(new Request("https://app.test/api/voicevox/jobs/register", { method: "POST", headers, body: JSON.stringify(input) }), env);
    assert.equal(response.status, 202, await response.clone().text());
    const registered = await response.json(), backend = index < 3 ? "vpc" : "cloud-run";
    assert.deepEqual(registered.jobs.map(job => job.backend), candidates.map(() => backend));
    for (const job of registered.jobs) {
      const status = await api.handleVoicevoxJobApi(new Request(`https://app.test/api/voicevox/jobs/${encodeURIComponent(job.jobId)}`, { headers }), env);
      assert.equal((await status.json()).backend, backend);
    }
    assert.deepEqual(deliveries.filter(delivery => delivery.generationId === generationId).map(delivery => delivery.backend), candidates.map(() => backend));
    inputs.push({ input, headers });
  }
  const pinned = inputs[2];
  const conflict = await api.handleVoicevoxJobApi(new Request("https://app.test/api/voicevox/jobs/register", { method: "POST", headers: pinned.headers, body: JSON.stringify({ ...pinned.input, backendPreference: "cloud-run" }) }), env);
  assert.equal(conflict.status, 400);
  assert.equal(deliveries.length, candidateCount * 5);
});

test("API rejects unknown backend choices before consuming any grant", async () => {
  const db = new D1(); await db.migrate();
  const generationId = randomUUID(), now = Date.now(), secret = "x".repeat(32), voiceGrant = randomUUID();
  db.db.prepare("INSERT INTO voicevox_grants (grant_hash,generation_id,candidate_id,issued_at,expires_at) VALUES (?,?,?,?,?)").run(sha(voiceGrant), generationId, "candidate-a", now - 1, now + 100000);
  const capability = await api.createVoicevoxJobCapability(generationId, secret, now, 100000);
  const queue = { send: async () => assert.fail("invalid preference must not enqueue") };
  const env = { EVALUATIONS_DB: db, TEMPORARY_AUDIO: new Bucket(), EVALUATION_RECEIPT_SECRET: secret, VOICEVOX_JOB_QUEUES: { vpc: queue, "cloud-run": queue } };
  for (const backendPreference of [null, "local", "cloudflare-vpc", 42, {}]) {
    const request = new Request("https://app.test/api/voicevox/jobs/register", { method: "POST", headers: { Origin: "https://app.test", "Content-Type": "application/json", "X-Voicevox-Capability": capability }, body: JSON.stringify({ groupId: generationId, generationId, backendPreference, candidates: [{ candidateId: "candidate-a", voiceGrant, score }] }) });
    const response = await api.handleVoicevoxJobApi(request, env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid-job-request");
  }
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM voicevox_jobs").get().n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM voicevox_grants WHERE consumed_at IS NOT NULL").get().n, 0);
});
