import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { networkInterfaces } from 'node:os';
import { loadEnv } from 'vite';
import { generateEkakiUta } from '../../server/geminiMiddleware';
import { groupStrokes } from '../../services/strokeGroupingService';
import { ExhibitionStore } from './store';
import { acquireServerLock } from './lock';
import { arrange } from '../music';
import { prepareLyrics } from './lyrics';
import type { DrawingData, LyricsResponse } from '../../types';
import { ROLE_IDS, pendingTask, type RoleId, type Instrument, type PublicState, type Task } from '../shared';

const root = process.cwd(), env = { ...loadEnv('development', root, ''), ...loadEnv('exhibition', root, ''), ...process.env };
const dataDir = path.resolve(env.EXHIBITION_DATA_DIR || 'exhibition-data');
await fs.mkdir(dataDir, { recursive: true });
const releaseLock = await acquireServerLock(dataDir);
const store = await ExhibitionStore.open(dataDir);
const streams = new Set<ServerResponse>();
let display: { id: string; until: number; ready: boolean } | null = null;
const cloud = Boolean(env.EXHIBITION_VOICE_URL && env.EXHIBITION_TOKEN);
const port = Number(env.EXHIBITION_PORT || 3001);
const broadcast = () => { for (const res of streams) res.write(`data: ${JSON.stringify({ revision: store.state.revision })}\n\n`); };
store.onChange = broadcast;
function snapshot(deviceId: string | null, workId: string | null): PublicState {
  const latest = store.state.tasks.filter(t => t.deviceId === deviceId).at(-1);
  const detailed = new Set([...store.state.members.map(m => m.workId), ...(store.state.performance?.members.map(m => m.workId) ?? []), latest?.workId, workId]);
  return {
    ...store.state,
    works: store.state.works.map(w => ({ ...w, drawing: { ...w.drawing, strokes: detailed.has(w.id) ? w.drawing.strokes : [], strokeGroups: detailed.has(w.id) ? w.drawing.strokeGroups : [], imageUri: `/api/exhibition/image/${encodeURIComponent(w.id)}` } })),
    tasks: store.state.tasks.map(({ drawing, lyrics, ...t }) => ({ ...t, ...(t.id === latest?.id && drawing ? { drawing: { ...drawing, imageUri: `/api/exhibition/task-image/${t.id}` } } : {}) })),
    display: { connected: !!display && display.until > Date.now(), ready: !!display && display.until > Date.now() && display.ready }, cloudConfigured: cloud,
  };
}
const send = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON形式で送信してください');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 15 * 1024 * 1024) throw new Error('作品データが大きすぎます'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString());
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('操作の形式が正しくありません'); return value;
}
function drawing(value: unknown): DrawingData {
  const d = value as DrawingData;
  if (!d || typeof d.imageUri !== 'string' || !/^data:image\/png;base64,/.test(d.imageUri) || !Array.isArray(d.strokes) || d.strokes.length > 2000 || d.strokes.length === 0) throw new Error('絵のデータを確認してください');
  let count = 0;
  for (const s of d.strokes) { if (!Array.isArray(s.points)) throw new Error('筆順が正しくありません'); count += s.points.length; if (count > 150000 || s.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('筆順が大きすぎるか不正です'); }
  return { ...d, strokeGroups: groupStrokes(d.strokes) };
}
const id = (v: unknown) => { if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(v)) throw new Error('識別子が正しくありません'); return v; };
let active = 0, localBusy = false;
const controllers = new Map<string, AbortController>();
async function synthesize(t: Task, lyrics: LyricsResponse, signal: AbortSignal) {
  const wait = (ms: number) => delay(ms, undefined, { signal });
  signal.throwIfAborted();
  const score = arrange(lyrics, t.role, store.state.melodySeed).score;
  if (t.backend === 'local') {
    while (localBusy) await wait(500);
    signal.throwIfAborted();
    localBusy = true;
    try {
      const base = 'http://127.0.0.1:50021';
      const q = await fetch(`${base}/sing_frame_audio_query?speaker=6000`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(score), signal: AbortSignal.timeout(60000) });
      signal.throwIfAborted();
      if (!q.ok) throw new Error('ローカルVOICEVOXに接続できません');
      const a = await fetch(`${base}/frame_synthesis?speaker=3003`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await q.json()), signal: AbortSignal.timeout(120000) });
      if (!a.ok) throw new Error('ローカルVOICEVOXで歌声を作れませんでした');
      return { audio: new Uint8Array(await a.arrayBuffer()), backend: 'local' };
    } finally { localBusy = false; }
  }
  if (!cloud) throw new Error('クラウド音声の接続設定が必要です。管理画面でローカルVOICEVOXにも切り替えられます。');
  const started = Date.now(); let failures = 0;
  while (Date.now() - started < 8 * 60000) {
    let response: Response;
    try { response = await fetch(`${env.EXHIBITION_VOICE_URL!.replace(/\/$/, '')}/synthesize`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.EXHIBITION_TOKEN}` }, body: JSON.stringify({ score, backend: t.backend }), signal: AbortSignal.any([signal, AbortSignal.timeout(210000)]) }); }
    catch { signal.throwIfAborted(); if (++failures >= 3) throw new Error('歌声サーバーとの通信を確認してください'); await wait(2000); continue; }
    if (response.ok) return { audio: new Uint8Array(await response.arrayBuffer()), backend: response.headers.get('X-Voicevox-Backend') ?? 'cloud' };
    await response.body?.cancel();
    if (response.status === 429) { t.message = '歌声サーバーが空くのを待っています'; await store.save(); await wait(1500); continue; }
    if (response.status === 401 || response.status === 403) throw new Error('クラウド音声の認証設定を確認してください');
    if (++failures >= 3 || response.status < 500) throw new Error('歌声を作れませんでした。もう一度試すか、管理画面で接続先を変更してください');
    await wait(2000);
  }
  throw new Error('歌声の待ち時間を超えました。もう一度試してください');
}
async function run(t: Task) {
  const controller = new AbortController(); controllers.set(t.id, controller);
  const signal = controller.signal;
  try {
    let lyrics = t.lyrics;
    if (!lyrics) {
      t.status = 'lyrics'; t.message = '歌詞を考え中'; await store.save();
      signal.throwIfAborted();
      const result = await generateEkakiUta(t.drawing!, { ...env, LYRICS_CANDIDATE_COUNT: '1' }, signal);
      signal.throwIfAborted();
      lyrics = 'candidates' in result ? result.candidates[0] : result;
      t.lyrics = lyrics;
    }
    signal.throwIfAborted();
    lyrics = await prepareLyrics(lyrics, env, signal); signal.throwIfAborted(); t.lyrics = lyrics;
    t.status = 'voice'; t.message = '歌声を作成中'; await store.save();
    const { audio, backend } = await synthesize(t, lyrics, signal);
    signal.throwIfAborted();
    await store.complete(t, lyrics, audio, backend);
  } catch (e) { if (pendingTask(t)) { t.status = 'failed'; t.message = e instanceof Error ? e.message : '歌を作れませんでした'; await store.save(); } }
  finally { controllers.delete(t.id); active--; pump(); }
}
function pump() {
  for (const t of store.state.tasks.filter(t => t.status === 'queued')) {
    if (active >= 3) break;
    t.status = t.lyrics ? 'voice' : 'lyrics'; active++; void run(t).catch(e => console.error('保存に失敗しました', e instanceof Error ? e.message : 'storage-error'));
  }
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { send(res, 403, { error: '別のページからの操作は受け付けません' }); return; }
    const route = url.pathname;
    if (route.startsWith('/api/exhibition/')) {
      if (route === '/api/exhibition/state' && req.method === 'GET') { send(res, 200, snapshot(url.searchParams.get('deviceId'), url.searchParams.get('workId'))); return; }
      if (route === '/api/exhibition/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write('data: {}\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
      }
      const audio = /^\/api\/exhibition\/audio\/([a-f0-9-]{36})\.wav$/.exec(route);
      if (audio && req.method === 'GET') { const bytes = await fs.readFile(path.join(dataDir, 'audio', `${audio[1]}.wav`)); res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=31536000, immutable' }); res.end(bytes); return; }
      const picture = /^\/api\/exhibition\/(image|task-image)\/([^/]+)$/.exec(route);
      if (picture && req.method === 'GET') {
        const imageId = decodeURIComponent(picture[2]);
        const uri = (picture[1] === 'image' ? store.state.works.find(w => w.id === imageId)?.drawing : store.state.tasks.find(t => t.id === imageId)?.drawing)?.imageUri;
        if (!uri) { send(res, 404, { error: 'not-found' }); return; }
        const bytes = Buffer.from(uri.split(',')[1], 'base64'); res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=3600' }); res.end(bytes); return;
      }
      if (req.method !== 'POST') { send(res, 404, { error: 'not-found' }); return; }
      const body = await readJson(req);
      if (route === '/api/exhibition/generate') {
        if (typeof body.id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.id)) throw new Error('操作IDが正しくありません');
        const instrument = body.instrument as Instrument | undefined;
        if (instrument && !['drums', 'piano', 'strings'].includes(instrument)) throw new Error('パートが正しくありません');
        const role = body.role as RoleId | undefined;
        if (role && !ROLE_IDS.includes(role)) throw new Error('パートが正しくありません');
        const t = store.enqueue({ id: id(body.id), deviceId: id(body.deviceId), workId: body.workId ? id(body.workId) : undefined, drawing: body.drawing ? drawing(body.drawing) : undefined, instrument, role });
        await store.save(); send(res, 202, { taskId: t.id }); pump(); return;
      }
      if (route === '/api/exhibition/cancel') {
        if (!store.state.tasks.some(t => t.id === body.taskId)) { send(res, 200, { ok: true }); return; }
        const t = store.cancel(id(body.taskId), id(body.deviceId)); controllers.get(t.id)?.abort();
        await store.save(); send(res, 200, { ok: true }); pump(); return;
      }
      if (route === '/api/exhibition/retry') {
        const t = store.state.tasks.find(t => t.id === body.taskId && t.deviceId === body.deviceId && t.status === 'failed');
        if (!t) throw new Error('再試行できる歌がありません');
        if (store.state.tasks.some(x => x.deviceId === t.deviceId && pendingTask(x))) throw new Error('この端末の歌を作っています');
        t.status = 'queued'; t.backend = store.state.backend; t.message = 'もう一度作ります'; await store.save(); send(res, 202, { taskId: t.id }); pump(); return;
      }
      if (route === '/api/exhibition/join') store.join(id(body.workId), id(body.versionId));
      else if (route === '/api/exhibition/select-version') {
        const work = store.state.works.find(w => w.id === body.workId);
        if (!work?.versions.some(v => v.id === body.versionId)) throw new Error('保存した歌が見つかりません');
        work.selectedVersion = String(body.versionId);
      }
      else if (route === '/api/exhibition/leave') store.state.members = store.state.members.filter(m => m.workId !== body.workId);
      else if (route === '/api/exhibition/delete') { await store.remove(id(body.workId)); send(res, 200, { ok: true }); return; }
      else if (route === '/api/exhibition/import') { send(res, 200, { count: await store.importLegacy(path.resolve(env.DEMO_RECORDS_DIR || 'demo-records')) }); return; }
      else if (route === '/api/exhibition/settings') {
        if (body.participantLimit !== undefined) store.setLimit(body.participantLimit as number);
        if (body.volume !== undefined) { if (typeof body.volume !== 'number' || body.volume < 0 || body.volume > 1) throw new Error('音量を確認してください'); store.state.volume = body.volume; }
        if (body.backend !== undefined) { if (!['auto', 'vpc', 'cloud-run', 'local'].includes(String(body.backend))) throw new Error('接続先を確認してください'); store.state.backend = body.backend as Task['backend']; }
      } else if (route === '/api/exhibition/display') {
        const displayId = id(body.displayId);
        if (display && display.until > Date.now() && display.id !== displayId) { send(res, 409, { error: '別の大画面が接続されています' }); return; }
        const changed = !display || display.ready !== Boolean(body.ready) || display.until < Date.now();
        display = { id: displayId, until: Date.now() + 9000, ready: Boolean(body.ready) };
        if (!display.ready && store.state.performance && ['preparing', 'playing'].includes(store.state.performance.status)) { store.state.performance.status = 'stopped'; await store.save(); }
        if (changed) broadcast(); send(res, 200, { ok: true }); return;
      } else if (route === '/api/exhibition/play') {
        if (!display || display.until <= Date.now() || !display.ready) throw new Error('大画面で「音を有効にする」を押してください');
        store.start();
      } else if (route === '/api/exhibition/stop') { if (store.state.performance) store.state.performance.status = 'stopped'; }
      else if (route === '/api/exhibition/ack') {
        if (!display || display.id !== body.displayId || display.until <= Date.now()) throw new Error('大画面との接続を確認してください');
        const p = store.state.performance;
        if (p?.id === body.performanceId && ['preparing', 'playing'].includes(p.status) && ['playing', 'finished', 'stopped'].includes(String(body.status))) p.status = body.status as 'playing' | 'finished' | 'stopped';
      } else { send(res, 404, { error: 'not-found' }); return; }
      await store.save(); send(res, 200, { ok: true }); return;
    }
    const relative = decodeURIComponent(route).replace(/^\/+/, '');
    const client = path.resolve('.exhibition-build/client');
    let file = path.resolve(client, relative || 'index.html');
    if (!file.startsWith(client + path.sep)) throw new Error('not-found');
    if (!path.extname(relative)) file = path.join(client, 'index.html');
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };
    const bytes = await fs.readFile(file); res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': path.extname(file) === '.html' ? 'no-store' : 'no-cache' }); res.end(bytes);
  } catch (e) { if (!res.headersSent) send(res, (e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400, { error: e instanceof Error ? e.message : '操作に失敗しました' }); else res.end(); }
});
setInterval(() => {
  for (const s of streams) s.write(': heartbeat\n\n');
  if (display && display.until <= Date.now()) { display = null; if (store.state.performance && ['preparing', 'playing'].includes(store.state.performance.status)) { store.state.performance.status = 'stopped'; void store.save(); } else broadcast(); }
}, 3000).unref();
server.listen(port, '0.0.0.0', () => {
  console.log(`展示デモ http://localhost:${port}\n大画面 /stage  操作 /control  保存作品 /admin\n保存先: ${dataDir}`);
  for (const items of Object.values(networkInterfaces())) for (const a of items ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`端末から: http://${a.address}:${port}`);
  pump();
});
async function shutdown() { server.close(); for (const s of streams) s.end(); await store.save(); await releaseLock(); process.exit(0); }
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
