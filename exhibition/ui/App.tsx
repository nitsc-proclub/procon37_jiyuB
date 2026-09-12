import React, { useCallback, useEffect, useRef, useState } from 'react';
import PaintCanvas from '../../components/PaintCanvas';
import type { DrawingData } from '../../types';
import { EnsembleAudio } from '../audio';
import { ROLES, STAGE_ORDER, newId, selectedWorks, playableVersion, pendingTask, type PublicState, type Instrument, type RoleId, type Version } from '../shared';
import Drawing from './Drawing';
import Stage, { LiveLyric, MiniStage, RoleBadge } from './Stage';

const api = async <T,>(route: string, body?: unknown): Promise<T> => {
  const response = await fetch(`/api/exhibition/${route}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value && typeof value === 'object' && 'error' in value ? String(value.error) : '通信を確認してください');
  return value as T;
};
function deviceId() { let id = localStorage.getItem('exhibition-device'); if (!id) { id = newId(); localStorage.setItem('exhibition-device', id); } return id; }
const initialWork = () => new URLSearchParams(location.search).has('new') ? null : new URLSearchParams(location.search).get('work') || sessionStorage.getItem('exhibition-work');

export default function ExhibitionApp() {
  const view = location.pathname === '/stage' ? 'stage' : location.pathname === '/control' ? 'control' : location.pathname === '/admin' ? 'admin' : 'maker';
  const [state, setState] = useState<PublicState | null>(null), [error, setError] = useState(''), [connected, setConnected] = useState(false);
  const [device] = useState(deviceId), [workId, setWorkId] = useState<string | null>(initialWork);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(() => sessionStorage.getItem('exhibition-task'));
  const [busy, setBusy] = useState(false), [hasStrokes, setHasStrokes] = useState(false), [chooser, setChooser] = useState(false);
  const [toast, setToast] = useState(''), [reset, setReset] = useState(0), [ready, setReady] = useState(false), [previewing, setPreviewing] = useState(false);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<DrawingData | null>(null);
  const audio = useRef<EnsembleAudio | null>(null), handled = useRef(''), activePerformance = useRef('');
  const generation = useRef(0), request = useRef<Promise<unknown>>(Promise.resolve()), cancelling = useRef<Promise<unknown>>(Promise.resolve());
  const taskIdRef = useRef(activeTaskId), [displayId] = useState(newId);
  const clock = useCallback(() => audio.current?.elapsed ?? 0, []);
  const refresh = useCallback(async () => {
    try {
      const value = await api<PublicState>(`state?deviceId=${device}${workId ? `&workId=${encodeURIComponent(workId)}` : ''}`);
      setState(old => old && old.revision > value.revision ? old : value); setConnected(true);
    } catch { setConnected(false); }
  }, [device, workId]);
  useEffect(() => {
    void refresh(); const events = new EventSource('/api/exhibition/events'); events.onmessage = () => void refresh(); events.onerror = () => setConnected(false);
    const timer = setInterval(() => void refresh(), 5000);
    return () => { events.close(); clearInterval(timer); };
  }, [refresh]);
  useEffect(() => () => audio.current?.dispose(), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);
  const act = async (route: string, body: unknown, message = '') => {
    setError(''); try { await api(route, body); await refresh(); if (message) setToast(message); return true; }
    catch (e) { setError(e instanceof Error ? e.message : '操作できませんでした'); return false; }
  };
  const player = () => audio.current ?? (audio.current = new EnsembleAudio());
  const stopPreview = () => { audio.current?.stop(); setPreviewing(false); };
  const selectWork = (id: string | null) => { setWorkId(id); if (id) sessionStorage.setItem('exhibition-work', id); else sessionStorage.removeItem('exhibition-work'); };
  const trackTask = (id: string | null) => { taskIdRef.current = id; setActiveTaskId(id); if (id) sessionStorage.setItem('exhibition-task', id); else sessionStorage.removeItem('exhibition-task'); };
  const task = state?.tasks.find(t => t.id === activeTaskId);
  const generating = !!task && pendingTask(task);
  useEffect(() => {
    if (task?.status === 'complete' && task.id === taskIdRef.current) { selectWork(task.workId); trackTask(null); setBusy(false); }
    if (task?.status === 'cancelled' && task.id === taskIdRef.current) trackTask(null);
  }, [task?.id, task?.status]);
  const work = state?.works.find(w => w.id === workId), version = work?.versions.find(v => v.id === work.selectedVersion);
  const playable = version && playableVersion(version);
  const joined = !!state?.members.some(m => m.workId === workId);
  const selectedJoined = !!state?.members.some(m => m.workId === workId && m.versionId === version?.id);
  const performing = state?.performance, stageActive = !!performing && ['preparing', 'playing'].includes(performing.status);
  const sortCards = (cards: ReturnType<typeof selectedWorks>) => cards.sort((a, b) => STAGE_ORDER.indexOf(a.member.role) - STAGE_ORDER.indexOf(b.member.role));
  const nextCards = state ? sortCards(selectedWorks(state, state.members)) : [];
  const cards = state ? sortCards(selectedWorks(state, view === 'stage' && performing && stageActive ? performing.members : state.members)) : [];

  useEffect(() => {
    if (view !== 'stage') return;
    let ended = false;
    const heartbeat = async () => {
      try { await api('display', { displayId, ready }); if (!ended) setError(old => old === '別の大画面が接続されています' ? '' : old); }
      catch (e) { if (!ended) { setError(e instanceof Error ? e.message : '接続が切れました'); setReady(false); audio.current?.stop(); } }
    };
    void heartbeat(); const timer = setInterval(() => void heartbeat(), 2500);
    return () => { ended = true; clearInterval(timer); };
  }, [view, ready, displayId]);
  useEffect(() => {
    if (view !== 'stage' || !state) return;
    const p = state.performance;
    if (!connected || !ready || p?.status === 'stopped') { audio.current?.stop(); activePerformance.current = ''; if (!connected && ready) setReady(false); return; }
    if (!p || p.status !== 'preparing' || handled.current === p.id) return;
    handled.current = p.id; activePerformance.current = p.id; setError('');
    const voices = sortCards(selectedWorks(state, p.members));
    void player().play(voices.map((item, i) => ({ version: item.version, pan: voices.length <= 1 ? 0 : i / (voices.length - 1) * 1.3 - .65 })), 2, state.volume).then(async started => {
      if (started && activePerformance.current === p.id) await api('ack', { displayId, performanceId: p.id, status: 'playing' });
    }).catch(e => { audio.current?.stop(); setError(e instanceof Error ? e.message : '再生できませんでした'); void api('ack', { displayId, performanceId: p.id, status: 'stopped' }).catch(() => {}); });
  }, [state?.performance?.id, state?.performance?.status, connected, ready]);
  useEffect(() => { if (state && view === 'stage' && audio.current?.active) audio.current.setVolume(state.volume); }, [state?.volume, view]);
  useEffect(() => {
    const timer = setInterval(() => {
      const a = audio.current;
      if (a?.active && a.elapsed >= a.duration + .12) {
        a.stop(); setPreviewing(false);
        if (view === 'stage' && activePerformance.current) { const performanceId = activePerformance.current; activePerformance.current = ''; void api('ack', { displayId, performanceId, status: 'finished' }).catch(() => {}); }
      }
    }, 50);
    return () => clearInterval(timer);
  }, [view, displayId]);

  const newSong = () => {
    const cancelId = taskIdRef.current;
    generation.current++; stopPreview(); setBusy(false); trackTask(null); selectWork(null); setDraft(null); setChooser(false); setError(''); setHasStrokes(false); setReset(n => n + 1);
    history.replaceState({}, '', '/');
    if (cancelId) {
      // Reset the canvas now; serialize cancellation behind submission to avoid a POST race.
      cancelling.current = request.current.catch(() => {}).then(() => api('cancel', { taskId: cancelId, deviceId: device })).catch(e => setError(e instanceof Error ? e.message : '中止の通信を確認してください'));
    }
  };
  const generate = async (drawing?: DrawingData, instrument?: Instrument, role?: RoleId) => {
    if (drawing) setDraft(drawing);
    const serial = ++generation.current, id = newId(); stopPreview(); setBusy(true); setChooser(false); setError(''); trackTask(id);
    const submission = cancelling.current.then(async () => {
      if (generation.current !== serial) return;
      return api('generate', { id, deviceId: device, ...(drawing ? { drawing } : { workId: work?.id }), instrument, role });
    });
    request.current = submission;
    try { await submission; if (serial === generation.current) await refresh(); }
    catch (e) { if (serial === generation.current) { trackTask(null); setError(e instanceof Error ? e.message : '作成できませんでした'); } }
    finally { if (serial === generation.current) setBusy(false); }
  };
  const preview = async (v: Version) => {
    setError(''); const serial = generation.current; setBusy(true);
    try { const started = await player().play([{ version: v, pan: 0 }], 1, .8, false); if (serial === generation.current) setPreviewing(started); }
    catch (e) { if (serial === generation.current) setError(e instanceof Error ? e.message : '再生できませんでした'); }
    finally { if (serial === generation.current) setBusy(false); }
  };

  const result = work && <section className="ex-card ex-result">
    {version && <RoleBadge role={version.role}/>}<h1>{work.title}</h1>
    {playable ? <><button className="ex-button secondary" disabled={busy} onClick={() => previewing ? stopPreview() : void preview(version)}>{previewing ? '■ とめる' : '▶ 聴いてみる'}</button>
      <button className="ex-button primary" disabled={busy || selectedJoined || !connected} onClick={() => { stopPreview(); void act('join', { workId: work.id, versionId: version.id }, stageActive ? 'つぎの合奏に参加！' : '合奏に参加！'); }}>{selectedJoined ? '✓ 参加中' : '＋ 合奏に参加する'}</button></> : <button className="ex-button primary" disabled={busy} onClick={() => void generate(undefined, undefined, version?.role)}>歌声を作る</button>}
    {joined && <button className="ex-link" onClick={() => void act('leave', { workId: work.id })}>合奏から外す</button>}
    <button className="ex-button secondary ex-new-song" onClick={newSong}>＋ 新しい歌を作る</button>
    {version && !playable && <small>新しい歌い方で作り直せます</small>}
    <button className="ex-link" onClick={() => setChooser(!chooser)} aria-expanded={chooser}>歌い方を変える {chooser ? '−' : '＋'}</button>
    {chooser && <div className="ex-role-chooser">{(['drums', 'strings', 'piano'] as Instrument[]).map(instrument => <button className={instrument} key={instrument} disabled={busy} onClick={() => void generate(undefined, instrument)}>{instrument === 'drums' ? 'リズム' : instrument === 'strings' ? 'ハーモニー' : 'メロディー'}</button>)}<details><summary>パートを選ぶ</summary><div>{STAGE_ORDER.map(role => <button key={role} disabled={busy} onClick={() => void generate(undefined, undefined, role)}>{ROLES[role].label} · {ROLES[role].detail}</button>)}</div></details></div>}
    {(work.versions.filter(playableVersion).length > 1 || !playable && work.versions.some(playableVersion)) && <label className="ex-version-select">保存した歌<select value={playable ? version.id : ''} onChange={e => { stopPreview(); void act('select-version', { workId: work.id, versionId: e.target.value }); }}><option value="" disabled>歌を選ぶ</option>{work.versions.filter(playableVersion).map((v, i) => <option key={v.id} value={v.id}>{i + 1}. {ROLES[v.role].label} · {ROLES[v.role].detail}</option>)}</select></label>}
    <details className="ex-work-options"><summary>作品の操作</summary><button className="ex-link danger" onClick={async () => { if (confirm(`「${work.title}」を削除しますか？`)) { if (await act('delete', { workId: work.id })) newSong(); } }}>保存作品を削除</button></details>
  </section>;

  return <div className={`ex-app ex-${view}`}>
    <header className="ex-header"><a href="/"><img src="/logo.png" alt="超えかき歌！"/></a><span className="ex-header-label">みんなの合奏</span><span className={`ex-connection ${connected ? '' : 'offline'}`}>{connected ? '接続中' : '接続を確認中'}</span><details className="ex-menu"><summary>メニュー ☰</summary><nav><a href="/">つくる</a><a href="/admin">保存作品</a><a href="/control">演奏する</a><a href="/stage">大画面</a>{view === 'stage' && <button onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen().catch(() => setError('ブラウザーの全画面表示を使ってください')); }}>全画面 ⛶</button>}</nav></details></header>
    {error && <div className="ex-error" role="alert">{error}<button onClick={() => setError('')} aria-label="閉じる">×</button></div>}
    {!state ? <div className="ex-loading">つないでいます…</div> : <>
      {view === 'maker' && <main className="ex-maker-main"><div className="ex-maker-toolbar"><a className="ex-link" href="/admin">‹ 保存作品</a><span>{generating || busy && activeTaskId ? '歌を作成中' : work ? 'きみの絵かき歌' : '絵を描いて、歌を作ろう'}</span>{(work || generating || activeTaskId) && <button className="ex-link" onClick={newSong}>{generating || activeTaskId ? '中止して新しく描く' : '新しい歌を作る ＋'}</button>}</div>
        <div className="ex-maker-layout"><section className="ex-paper">
          {generating || busy && activeTaskId ? task?.drawing || work || draft ? <Drawing drawing={task?.drawing ?? work?.drawing ?? draft!} complete/> : <div className="ex-placeholder">♪</div> : work ? <><Drawing drawing={work.drawing} mappings={work.lyrics.lineStrokeMappings} clock={previewing ? clock : undefined} complete={!previewing}/><LiveLyric work={work} clock={clock} playing={previewing}/></> : <PaintCanvas key={reset} initialDrawing={draft ?? (task?.status === 'failed' ? task.drawing : undefined)} onComplete={d => void generate(d)} onClear={() => { selectWork(null); setDraft(null); }} isGenerating={false} hideFocusControl onDrawingMetricsChange={m => setHasStrokes(m.strokeCount > 0)} guideState={hasStrokes ? null : 'draw'}/>}
        </section><aside className="ex-maker-side">
          {generating || busy && activeTaskId ? <section className="ex-card ex-generating"><div className="ex-orbit" aria-hidden="true">♪</div>{task && <RoleBadge role={task.role}/>}<h1>{task?.status === 'lyrics' ? '歌詞を考え中' : task?.status === 'voice' ? '歌声を作成中' : '順番待ち'}</h1><div className="ex-progress"><i/></div><button className="ex-button secondary" onClick={newSong}>中止して新しく描く</button></section> : work ? result : <section className="ex-card ex-invitation"><div className="ex-music-symbols" aria-hidden="true">♪ ♫ ♪</div><h1>きみの絵も、<br/>音楽のなかま。</h1><div className="ex-simple-steps"><span>かく</span><b>→</b><span>うたう</span><b>→</b><span>合奏！</span></div></section>}
          {task?.status === 'failed' && <section className="ex-card ex-failed"><h2>もう一度試そう</h2><p>{task.message}</p><button className="ex-button secondary" onClick={() => void act('retry', { taskId: task.id, deviceId: device })}>もう一度作る</button><button className="ex-link" onClick={newSong}>新しい歌を作る</button></section>}
          <MiniStage cards={nextCards}/>
        </aside></div></main>}
      {view === 'stage' && <><Stage cards={cards} next={nextCards} clock={clock} playing={stageActive} finished={performing?.status === 'finished'} limit={state.participantLimit}/>{!ready && <div className="ex-enable"><button className="ex-button primary" onClick={async () => { try { await player().enable(); setReady(true); setError(''); } catch (e) { setError(String(e)); } }}>音を有効にする</button></div>}</>}
      {view === 'control' && <main className="ex-control-main"><h1>みんなで演奏</h1><div className="ex-control-count"><strong>{nextCards.length}</strong><span> / {state.participantLimit} 人</span></div><button className={`ex-button ex-play-button ${stageActive ? 'secondary' : 'primary'}`} disabled={!connected || !stageActive && (!state.display.ready || !nextCards.length)} onClick={() => void act(stageActive ? 'stop' : 'play', {})}>{stageActive ? '■ とめる' : '▶ 合奏スタート'}</button><p>{!state.display.ready ? '大画面で音を有効にしてください' : stageActive ? '演奏中' : '2周うたうよ'}</p><MiniStage cards={nextCards}/><a className="ex-link" href="/admin">保存作品・人数設定</a></main>}
      {view === 'admin' && <main className="ex-admin-main"><div className="ex-library-heading"><h1>保存作品 <small>{state.works.length}</small></h1><button className="ex-button primary" onClick={newSong}>＋ 新しい歌を作る</button></div>
        <section className="ex-library-settings"><label className="ex-limit">合奏の人数<select aria-label="合奏の人数" value={state.participantLimit} onChange={e => void act('settings', { participantLimit: Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} 人{n === 4 ? '（標準）' : ''}</option>)}</select></label><details><summary>設定</summary><div className="ex-settings"><label>音量<input aria-label="合奏の音量" type="range" min="0" max="1" step="0.05" value={state.volume} onChange={e => void act('settings', { volume: Number(e.target.value) })}/></label><label>歌声の接続先<select value={state.backend} onChange={e => void act('settings', { backend: e.target.value })}><option value="auto">クラウド優先（自動）</option><option value="vpc">未来サーバー</option><option value="cloud-run">Google Cloud Run</option><option value="local">ローカル VOICEVOX</option></select></label><button className="ex-button secondary" onClick={async () => { try { const value = await api<{ count: number }>('import', {}); await refresh(); setToast(`${value.count}作品を追加しました`); } catch (e) { setError(String(e)); } }}>デモ記録を読み込む</button></div></details><a className="ex-link" href="/control">演奏する →</a></section>
        <label className="ex-search"><span>作品をさがす</span><input type="search" placeholder="タイトル" value={search} onChange={e => setSearch(e.target.value)}/></label>
        <section className="ex-gallery">{[...state.works].reverse().filter(w => !search || w.title.includes(search)).map(w => { const v = w.versions.find(v => v.id === w.selectedVersion); return <a className="ex-gallery-tile" key={w.id} href={`/?work=${encodeURIComponent(w.id)}`}><div className="ex-gallery-art"><img src={w.drawing.imageUri} alt={w.title} loading="lazy"/>{state.members.some(m => m.workId === w.id) && <span className="ex-joined-dot">参加中</span>}</div><h2>{w.title}</h2>{v && <RoleBadge role={v.role}/>}</a>; })}</section>{!state.works.length && <p className="ex-empty-library">まだ作品がありません</p>}
      </main>}
    </>}
    {toast && <div className="ex-toast" role="status">{toast}</div>}
    {view !== 'stage' && <footer className="ex-footer">超えかき歌！ <span>VOICEVOX:ずんだもん</span></footer>}
  </div>;
}
