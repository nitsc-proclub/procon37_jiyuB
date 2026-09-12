import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
const vite = await createServer({ configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, appType: 'custom' });
after(() => vite.close());
const shared = await vite.ssrLoadModule('/exhibition/shared.ts');
const { arrange, melodyKey } = await vite.ssrLoadModule('/exhibition/music.ts');
const { ExhibitionStore } = await vite.ssrLoadModule('/exhibition/server/store.ts');
const lyrics = { title: 'まるいねこ', identifiedObject: 'ねこ', lines: ['まるをかいて','みみをふたつ','ひげをかいて','ねこのできあがり'], singingKanaLines: ['まるお かいて','みみお ふたつ','ひげお かいて','ねこの できあがり'] };
const drawing = { imageUri: 'data:image/png;base64,aA==', strokes: [{ points: [{x: 0,y: 0,timestamp: 0},{x: 30,y: 30,timestamp: 1}],startTime: 0,endTime: 1 }] };
test('first three simultaneous reservations cover rhythm, root and melody; all six have separate slots', () => {
  const tasks = [];
  for (let i=0;i<6;i++) { const role = shared.chooseRole([], tasks, tasks.at(-1)?.role, undefined, () => 0); tasks.push({role,status:'queued'}); }
  assert.deepEqual(new Set(tasks.slice(0,3).map(t=>t.role)),new Set(['rhythm','root','melody']));
  assert.equal(new Set(tasks.map(t=>t.role)).size,6);
});
test('manual instrument works when full; ties avoid the preceding instrument', () => {
  assert.equal(shared.ROLES[shared.chooseRole([], [],'rhythm','drums')].instrument,'drums');
  const role=shared.chooseRole([], [],'rhythm',undefined,()=>0);
  assert.notEqual(shared.ROLES[role].instrument,'drums');
});
test('same-role replacement preserves other roles; retries do not change joinedAt', () => {
  const members=shared.ROLE_IDS.map((role,i)=>({workId:String(i),versionId:String(i),role,joinedAt:i}));
  const next=shared.joinMember(members,{workId:'new',versionId:'new',role:'rhythm',joinedAt:99});
  assert.equal(next.length,6);assert.ok(!next.some(m=>m.workId==='0'));assert.ok(next.some(m=>m.workId==='1'));
  assert.strictEqual(shared.joinMember(next,{...next.at(-1),joinedAt:100}),next);
});
test('requested chord boundaries and 2+2+4 last line are exact', () => {
  assert.deepEqual(shared.CHORDS.map(cs=>cs.map(c=>[c.name,c.units/4])),[[['F',4],['G',4]],[['Em',4],['Am',4]],[['F',4],['G',4]],[['Dm',2],['G',2],['C',4]]]);
  const a=arrange(lyrics,'root',123);let frame=-2;
  for (const n of a.score.notes) { if(n.key!==null) { const line=Math.floor(frame/360),unit=(frame%360)/360*32;let b=0;const chord=shared.CHORDS[line].find(c=>(b+=c.units)>unit);assert.equal(n.key,chord.keys[0]+12); } frame+=n.frame_length; }
});
test('all roles and varied kana fit four exact lines and retain positive note lengths', () => {
  for(const line of ['あ','きゃー ねこ','あ'.repeat(22),'まるお かいて みみ ふたつ']) for(const role of shared.ROLE_IDS){
    const a=arrange({...lyrics,singingKanaLines:Array(4).fill(line)},role,22);
    assert.equal(a.score.notes.reduce((s,n)=>s+n.frame_length,0),1442);
    assert.ok(a.score.notes.every(n=>Number.isInteger(n.frame_length)&&n.frame_length>0));
    assert.ok(a.score.notes.slice(1).every(n=>Number.isInteger(n.key)&&n.key>=0&&n.key<=127));
  }
});

test('melody stays finite for unsigned seeds, including the high bit', () => {
  for(const seed of [0,1,22,124,0x7fffffff,0x80000000,0xffffffff]) for(let line=0;line<4;line++) for(let cell=0;cell<4;cell++) {
    assert.ok(Number.isInteger(melodyKey(line,cell,seed)));
  }
  assert.throws(()=>arrange({...lyrics,singingKanaLines:['withあ','い','う','え']},'melody',1));
});
test('octave melody shares generated contour; saved seed reproduces the score', () => {
  const m=arrange(lyrics,'melody',124),o=arrange(lyrics,'octave',124);
  assert.deepEqual(m,arrange(lyrics,'melody',124));
  m.score.notes.slice(1).forEach((n,i)=>assert.equal(o.score.notes[i+1].key,n.key+12));
  assert.equal(melodyKey(3,3,124),60);
});
test('persistent queue, re-arrangement, playback snapshot and restart preserve originals', async () => {
  const directory=await mkdtemp(join(tmpdir(),'exhibition-test-'));
  try {
    const store=await ExhibitionStore.open(directory);
    const task=store.enqueue({id:randomUUID(),deviceId:'one',drawing,instrument:'drums'}); await store.save();
    assert.strictEqual(store.enqueue({id:task.id,deviceId:'one',drawing}),task);
    assert.throws(()=>store.enqueue({id:randomUUID(),deviceId:'one',drawing}));
    const wav=new Uint8Array(44);wav.set(Buffer.from('RIFF'),0);wav.set(Buffer.from('WAVE'),8);
    await store.complete(task,lyrics,wav,'test');store.join(task.workId,task.id);const p=store.start();
    const next=store.enqueue({id:randomUUID(),deviceId:'two',drawing,instrument:shared.ROLES[task.role].instrument});await store.complete(next,lyrics,wav,'test');store.join(next.workId,next.id);
    assert.equal(p.members[0].workId,task.workId);assert.equal(store.state.members[0].workId,next.workId);
    await assert.rejects(store.remove(task.workId));
    const change=store.enqueue({id:randomUUID(),deviceId:'one',workId:task.workId,instrument:'piano'});await store.complete(change,lyrics,wav,'test');
    assert.equal(store.state.works[0].versions.length,2);assert.deepEqual(store.state.works[0].lyrics,lyrics);
    assert.equal(p.members[0].versionId,task.id);
    const pending=store.enqueue({id:randomUUID(),deviceId:'three',drawing});pending.status='voice';pending.lyrics=lyrics;
    await store.save();const restored=await ExhibitionStore.open(directory);assert.equal(restored.state.performance.status,'stopped');assert.equal(restored.state.works.length,2);
    assert.equal(restored.state.tasks.at(-1).status,'queued');assert.deepEqual(restored.state.tasks.at(-1).drawing,drawing);
    assert.equal((await readFile(join(directory,'audio',task.id+'.wav'))).length,44);
  } finally { if(!directory.startsWith(join(tmpdir(),'exhibition-test-')))throw new Error('unsafe cleanup');await rm(directory,{recursive:true,force:true}); }
});

test('legacy import accepts Japanese record folders once and preserves its source', async () => {
  const directory=await mkdtemp(join(tmpdir(),'exhibition-test-'));
  try {
    const source=join(directory,'records'),record=join(source,'2026-09-12_ねこの絵かき歌');await mkdir(record,{recursive:true});
    const metadata=JSON.stringify({lyrics,drawing,files:{image:'input.png'},completedAt:'2026-09-12T00:00:00.000Z'});
    await writeFile(join(record,'metadata.json'),metadata);await writeFile(join(record,'input.png'),Buffer.from('test-image'));
    const store=await ExhibitionStore.open(join(directory,'data'));assert.equal(await store.importLegacy(source),1);assert.equal(await store.importLegacy(source),0);
    const work=store.state.works[0];assert.match(work.id,/^legacy-[a-f0-9]{24}$/);assert.deepEqual(work.lyrics,lyrics);assert.throws(()=>store.join(work.id,''));
    assert.equal((await readFile(join(record,'metadata.json'),'utf8')),metadata);
    assert.equal(store.enqueue({id:randomUUID(),deviceId:'admin',workId:work.id,instrument:'piano'}).workId,work.id);
  } finally { if(!directory.startsWith(join(tmpdir(),'exhibition-test-')))throw new Error('unsafe cleanup');await rm(directory,{recursive:true,force:true}); }
});
