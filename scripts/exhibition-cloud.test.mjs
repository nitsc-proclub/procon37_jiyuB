import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle=await build({entryPoints:['exhibition/cloud/worker.ts'],bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022'});
const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const secret='test-exhibition-secret-01234567890123456789';
const score={notes:[{lyric:'',key:null,frame_length:2},{lyric:'あ',key:60,frame_length:360}]};
function env({busy=false,reject=false}={}){
 const events=[];return {events,EXHIBITION_TOKEN:secret,
 EVALUATIONS_DB:{prepare(query){return{bind(){return{async run(){events.push(query.startsWith('INSERT')?'insert':'delete');return{success:true};}}}}}},
 VOICEVOX_INFRASTRUCTURE:{async acquireBackendLease(request){events.push('acquire:'+request.backend);return busy?{granted:false}:{granted:true,lease:{leaseId:'lease'}}},async releaseBackendLease(){events.push('release');}},
 PUBLIC_APP:{async fetch(url,init){events.push('synthesize');assert.equal(init.headers.Origin,new URL(url).origin);const payload=JSON.parse(init.body);assert.match(payload.voiceGrant,/^[A-Za-z0-9_-]{43}$/);assert.deepEqual(payload.score,score);if(reject)return Response.json({code:'voice-failed'},{status:502});const bytes=new Uint8Array(44);bytes.set(Buffer.from('RIFF'));bytes.set(Buffer.from('WAVE'),8);return new Response(bytes,{headers:{'Content-Type':'audio/wav'}});}}
 };}
const request=(body={score},token=secret)=>new Request('https://exhibition.test/synthesize',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
test('exhibition cloud rejects unauthenticated requests before touching shared services',async()=>{const e=env();assert.equal((await worker.fetch(request({score},'wrong'),e)).status,401);assert.deepEqual(e.events,[]);});
test('single score uses origin contract, consumes bounded WAV, then releases and deletes grant',async()=>{const e=env();const r=await worker.fetch(request(),e);assert.equal(r.status,200);assert.equal(r.headers.get('X-Voicevox-Backend'),'vpc');assert.equal((await r.arrayBuffer()).byteLength,44);assert.deepEqual(e.events,['acquire:vpc','insert','synthesize','release','delete']);});
test('busy backends yield to durable local queue without minting grants',async()=>{const e=env({busy:true});assert.equal((await worker.fetch(request(),e)).status,429);assert.deepEqual(e.events,['acquire:vpc','acquire:cloud-run']);});
test('forced Cloud Run and failed requests release capacity',async()=>{const e=env({reject:true});assert.equal((await worker.fetch(request({score,backend:'cloud-run'}),e)).status,502);assert.deepEqual(e.events,['acquire:cloud-run','insert','synthesize','release','delete']);});
test('invalid scores never call an upstream backend',async()=>{const e=env();assert.equal((await worker.fetch(request({score:{notes:[{lyric:'あ',key:60,frame_length:0}]}}),e)).status,400);assert.deepEqual(e.events,[]);});

test('temporary grant is removed even when releasing the backend lease fails',async()=>{const e=env();e.VOICEVOX_INFRASTRUCTURE.releaseBackendLease=async()=>{throw new Error('temporary infrastructure failure');};assert.equal((await worker.fetch(request(),e)).status,200);assert.ok(e.events.includes('delete'));});
