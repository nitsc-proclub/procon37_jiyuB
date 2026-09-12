import type { DrawingData, LyricsResponse, SingingScore } from '../types';

export const ROLE_IDS = ['rhythm', 'root', 'melody', 'third', 'fifth', 'octave'] as const;
export type RoleId = typeof ROLE_IDS[number];
export type Instrument = 'drums' | 'strings' | 'piano';
export const ROLES: Record<RoleId, { label: string; instrument: Instrument; detail: string; pan: number }> = {
  rhythm: { label: 'リズム', instrument: 'drums', detail: 'ビート', pan: -.65 },
  root: { label: 'ハーモニー', instrument: 'strings', detail: 'ルート', pan: -.3 },
  melody: { label: 'メロディー', instrument: 'piano', detail: '主旋律', pan: .3 },
  third: { label: 'ハーモニー', instrument: 'strings', detail: '3度', pan: -.3 },
  fifth: { label: 'ハーモニー', instrument: 'strings', detail: '5度', pan: .1 },
  octave: { label: 'メロディー', instrument: 'piano', detail: '1オクターブ下', pan: .65 },
};
export const STAGE_ORDER: RoleId[] = ['rhythm', 'root', 'third', 'fifth', 'melody', 'octave'];
export const DEFAULT_PARTICIPANT_LIMIT = 4;
export function rolesForLimit(limit: number): RoleId[] {
  if (limit === 1) return ['melody'];
  if (limit === 2) return ['rhythm', 'melody'];
  return (['rhythm', 'root', 'melody', 'fifth', 'third', 'octave'] as RoleId[]).slice(0, limit);
}
export const BPM = 125;
export const FPS = 93.75;
export const LEAD_FRAMES = 2;
export const LINE_FRAMES = 360;
export const SONG_FRAMES = LINE_FRAMES * 4 + LEAD_FRAMES;
export const SONG_SECONDS = SONG_FRAMES / FPS;
export const MUSIC_VERSION = 'ensemble-fg-emam-fg-dmgc-v1';
export const LOW_OCTAVE_VERSION = 'ensemble-fg-emam-fg-dmgc-low-octave-v2';
export const playableVersion = (v: Version) => v.arrangement.version === (v.role === 'octave' ? LOW_OCTAVE_VERSION : MUSIC_VERSION);
export const CHORDS = [
  [{ name: 'F', units: 16, keys: [53, 57, 60] }, { name: 'G', units: 16, keys: [55, 59, 62] }],
  [{ name: 'Em', units: 16, keys: [52, 55, 59] }, { name: 'Am', units: 16, keys: [57, 60, 64] }],
  [{ name: 'F', units: 16, keys: [53, 57, 60] }, { name: 'G', units: 16, keys: [55, 59, 62] }],
  [{ name: 'Dm', units: 8, keys: [50, 53, 57] }, { name: 'G', units: 8, keys: [55, 59, 62] }, { name: 'C', units: 16, keys: [48, 52, 55] }],
];
export type Arrangement = { version: string; role: RoleId; score: SingingScore; melodySeed: number; duration: number };
export type Work = { id: string; createdAt: string; title: string; drawing: DrawingData; lyrics: LyricsResponse; versions: Version[]; selectedVersion: string; error?: string };
export type Version = { id: string; role: RoleId; createdAt: string; arrangement: Arrangement; backend: string; audioUrl: string };
export type Member = { workId: string; versionId: string; role: RoleId; joinedAt: number };
export type Task = { id: string; deviceId: string; workId: string; role: RoleId; status: 'queued' | 'lyrics' | 'voice' | 'complete' | 'failed' | 'cancelled'; message: string; drawing?: DrawingData; lyrics?: LyricsResponse; createdAt: number; backend: 'auto' | 'vpc' | 'cloud-run' | 'local' };
export type Performance = { id: string; status: 'preparing' | 'playing' | 'finished' | 'stopped'; members: Member[]; createdAt: number };
export type State = { schemaVersion: 1; revision: number; melodySeed: number; works: Work[]; members: Member[]; tasks: Task[]; performance: Performance | null; lastRoles: Record<string, RoleId>; volume: number; backend: Task['backend']; participantLimit: number };
export type PublicState = State & { display: { connected: boolean; ready: boolean }; cloudConfigured: boolean };

export const pendingTask = (t: Task) => ['queued', 'lyrics', 'voice'].includes(t.status);
export function chooseRole(members: Member[], tasks: Task[], previous?: RoleId, instrument?: Instrument, random = Math.random, limit = DEFAULT_PARTICIPANT_LIMIT): RoleId {
  const count = (role: RoleId) => members.filter(m => m.role === role).length + tasks.filter(t => pendingTask(t) && t.role === role).length;
  let pool = rolesForLimit(limit).filter(r => !instrument || ROLES[r].instrument === instrument);
  if (!pool.length) pool = ROLE_IDS.filter(r => ROLES[r].instrument === instrument);
  if (!instrument) {
    const essential = pool.filter(r => ['rhythm', 'root', 'melody'].includes(r) && count(r) === 0);
    if (essential.length) pool = essential;
  }
  const min = Math.min(...pool.map(count));
  pool = pool.filter(r => count(r) === min);
  const varied = pool.filter(r => !previous || ROLES[r].instrument !== ROLES[previous].instrument);
  if (varied.length) pool = varied;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}
export function joinMember(members: Member[], member: Member, limit = 6): Member[] {
  const same = members.find(m => m.workId === member.workId && m.versionId === member.versionId);
  if (same) return members;
  return [...members.filter(m => m.role !== member.role && m.workId !== member.workId), member].sort((a, b) => a.joinedAt - b.joinedAt).slice(-limit);
}
export function selectedWorks(state: State, members: Member[]) {
  return members.flatMap(member => {
    const work = state.works.find(w => w.id === member.workId);
    const version = work?.versions.find(v => v.id === member.versionId);
    return work && version ? [{ member, work, version }] : [];
  });
}
export function newId() {
  // crypto.randomUUID requires a secure origin; exhibition tablets use private-LAN HTTP.
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(v => v.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
