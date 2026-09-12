import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { chooseRole, joinMember, playableVersion, pendingTask, rolesForLimit, DEFAULT_PARTICIPANT_LIMIT, type RoleId, type State, type Instrument, type Task, type Version, type Work } from '../shared';
import { arrange } from '../music';
import type { DrawingData, LyricsResponse } from '../../types';

export class ExhibitionStore {
  state: State;
  private writes: Promise<void> = Promise.resolve();
  onChange: () => void = () => {};
  constructor(readonly directory: string, initial?: State) {
    this.state = initial ?? { schemaVersion: 1, revision: 0, melodySeed: randomBytes(4).readUInt32LE(), works: [], members: [], tasks: [], performance: null, lastRoles: {}, volume: .75, backend: 'auto', participantLimit: DEFAULT_PARTICIPANT_LIMIT };
    this.setLimit(this.state.participantLimit ?? DEFAULT_PARTICIPANT_LIMIT);
    this.state.members = this.state.members.filter(m => this.state.works.find(w => w.id === m.workId)?.versions.some(v => v.id === m.versionId && playableVersion(v)));
  }
  static async open(directory: string) {
    await fs.mkdir(path.join(directory, 'audio'), { recursive: true });
    let state: State | undefined;
    try { state = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('保存データを読み込めません。state.jsonを確認してください。上書きはしていません。'); }
    if (state && state.schemaVersion !== 1) throw new Error('未対応の保存形式です。');
    const store = new ExhibitionStore(directory, state);
    if (store.state.performance) store.state.performance.status = 'stopped';
    for (const t of store.state.tasks) if (pendingTask(t)) { t.status = 'queued'; t.message = '順番待ち'; }
    await store.save(); return store;
  }
  async save() {
    this.state.revision++;
    const snapshot = JSON.stringify(this.state);
    const write = this.writes.then(async () => {
      const temporary = path.join(this.directory, 'state.json.tmp');
      await fs.writeFile(temporary, snapshot);
      await fs.rename(temporary, path.join(this.directory, 'state.json'));
    });
    this.writes = write.catch(() => {});
    await write; this.onChange();
  }
  setLimit(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 6) throw new Error('人数は1〜6人から選んでください');
    this.state.participantLimit = limit;
    const preferred = rolesForLimit(limit);
    this.state.members = [...this.state.members].sort((a, b) => Number(preferred.includes(b.role)) - Number(preferred.includes(a.role)) || b.joinedAt - a.joinedAt).slice(0, limit);
  }
  cancel(taskId: string, deviceId: string) {
    const t = this.state.tasks.find(t => t.id === taskId && t.deviceId === deviceId);
    if (!t) throw new Error('作成中の歌が見つかりません');
    if (pendingTask(t)) { t.status = 'cancelled'; t.message = '中止しました'; delete t.drawing; delete t.lyrics; }
    return t;
  }
  enqueue(input: { id: string; deviceId: string; drawing?: DrawingData; workId?: string; instrument?: Instrument; role?: RoleId }): Task {
    const existing = this.state.tasks.find(t => t.id === input.id);
    if (existing) { if (existing.deviceId !== input.deviceId) throw new Error('操作IDが重複しています'); return existing; }
    const pending = this.state.tasks.filter(pendingTask);
    if (pending.length >= 12) throw new Error('順番待ちがいっぱいです。少し待ってください。');
    if (pending.some(t => t.deviceId === input.deviceId)) throw new Error('この端末の歌を作っています。完成を待ってください。');
    const work = input.workId ? this.state.works.find(w => w.id === input.workId) : undefined;
    if (input.workId && !work) throw new Error('作品が見つかりません');
    if (!work && !input.drawing) throw new Error('絵を描いてください');
    const role = input.role ?? chooseRole(this.state.members, pending, this.state.lastRoles[input.deviceId], input.instrument, Math.random, this.state.participantLimit);
    const t: Task = { id: input.id, deviceId: input.deviceId, workId: work?.id ?? randomUUID(), role, status: 'queued', message: '歌を作る順番を待っています', drawing: work?.drawing ?? input.drawing, lyrics: work?.lyrics, createdAt: Date.now(), backend: this.state.backend };
    this.state.tasks.push(t); this.state.lastRoles[input.deviceId] = role;
    return t;
  }
  async complete(t: Task, lyrics: LyricsResponse, bytes: Uint8Array, backend: string) {
    if (!pendingTask(t)) return;
    if (bytes.length < 44 || Buffer.from(bytes.slice(0, 4)).toString() !== 'RIFF' || Buffer.from(bytes.slice(8, 12)).toString() !== 'WAVE') throw new Error('歌声の形式が正しくありません');
    const file = path.join(this.directory, 'audio', `${t.id}.wav`);
    await fs.writeFile(`${file}.tmp`, bytes); await fs.rename(`${file}.tmp`, file);
    if (!pendingTask(t)) { await fs.unlink(file); return; }
    const version: Version = { id: t.id, role: t.role, createdAt: new Date().toISOString(), arrangement: arrange(lyrics, t.role, this.state.melodySeed), backend, audioUrl: `/api/exhibition/audio/${t.id}.wav` };
    let work = this.state.works.find(w => w.id === t.workId);
    if (!work) { work = { id: t.workId, title: lyrics.title, createdAt: new Date().toISOString(), drawing: t.drawing!, lyrics, selectedVersion: version.id, versions: [] }; this.state.works.push(work); }
    work.versions = [...work.versions.filter(v => v.id !== version.id), version]; work.selectedVersion = version.id;
    t.status = 'complete'; t.message = '歌ができました'; delete t.drawing; delete t.lyrics;
    await this.save();
  }
  join(workId: string, versionId: string) {
    const work = this.state.works.find(w => w.id === workId);
    const v = work?.versions.find(v => v.id === versionId);
    if (!v || !playableVersion(v)) throw new Error('合奏用の歌声を作ってから参加してください');
    this.state.members = joinMember(this.state.members, { workId, versionId, role: v.role, joinedAt: Date.now() }, this.state.participantLimit);
  }
  start() {
    if (this.state.performance && ['preparing', 'playing'].includes(this.state.performance.status)) return this.state.performance;
    if (!this.state.members.length) throw new Error('まず作品を参加させてください');
    this.state.performance = { id: randomUUID(), status: 'preparing', members: structuredClone(this.state.members), createdAt: Date.now() };
    return this.state.performance;
  }
  async remove(workId: string) {
    if (this.state.tasks.some(t => t.workId === workId && pendingTask(t))) throw new Error('作成を中止してから削除してください');
    if (this.state.performance && ['preparing', 'playing'].includes(this.state.performance.status) && this.state.performance.members.some(m => m.workId === workId)) throw new Error('演奏を停止してから削除してください');
    const work = this.state.works.find(w => w.id === workId);
    this.state.members = this.state.members.filter(m => m.workId !== workId);
    this.state.works = this.state.works.filter(w => w.id !== workId);
    this.state.tasks = this.state.tasks.filter(t => t.workId !== workId);
    await this.save();
    for (const v of work?.versions ?? []) await fs.unlink(path.join(this.directory, 'audio', `${v.id}.wav`)).catch(() => {});
  }
  async importLegacy(root: string) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = `legacy-${createHash('sha256').update(entry.name).digest('hex').slice(0, 24)}`;
      if (this.state.works.some(w => w.id === id)) continue;
      try {
        const dir = path.join(root, entry.name), m = JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8'));
        const imageName = path.basename(m.files?.image ?? 'input.png');
        if (!m.lyrics?.singingKanaLines || m.lyrics.singingKanaLines.length !== 4) continue;
        const image = await fs.readFile(path.join(dir, imageName));
        const work: Work = { id, title: m.lyrics.title, createdAt: m.completedAt ?? m.savedAt ?? new Date().toISOString(), lyrics: m.lyrics, drawing: { strokes: [], ...m.drawing, imageUri: `data:image/png;base64,${image.toString('base64')}` }, versions: [], selectedVersion: '' };
        this.state.works.push(work); count++;
      } catch { /* A damaged/unsupported legacy record stays untouched in its source folder. */ }
    }
    await this.save(); return count;
  }
}
