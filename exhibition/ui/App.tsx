import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PaintCanvas from '../../components/PaintCanvas';
import type { DrawingData } from '../../types';
import { EnsembleAudio } from '../audio';
import { FPS, LEAD_FRAMES, LINE_FRAMES, SONG_SECONDS, ROLES, STAGE_ORDER, newId, selectedWorks, type PublicState, type Instrument, type RoleId, type Work, type Version } from '../shared';
import Drawing from './Drawing';

const api = async <T,>(route: string, body?: unknown, pin?: string): Promise<T> => {
  const response = await fetch(`/api/exhibition/${route}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...(pin ? { 'X-Exhibition-Pin': pin } : {}) }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value && typeof value === 'object' && 'error' in value ? String(value.error) : '通信を確認してください'); return value as T;
};
function deviceId() { let id = localStorage.getItem('exhibition-device'); if (!id) { id = newId(); localStorage.setItem('exhibition-device', id); } return id; }
function InstrumentIcon({ instrument }: { instrument: Instrument }) {
  return <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {instrument === 'drums' ? <><ellipse cx="32" cy="26" rx="22" ry="10"/><path d="M10 26v19c0 14 44 14 44 0V26M16 30l8 23 8-17 9 17 8-23M9 8l30 15M54 7L25 23"/></> : instrument === 'piano' ? <><rect x="8" y="12" width="48" height="42" rx="5"/><path d="M20 34v20M32 34v20M44 34v20"/><path d="M17 13h6v20h-6zM29 13h6v20h-6zM41 13h6v20h-6z" fill="currentColor"/></> : <><path d="M39 5l4 3-12 29M39 16l7 3M19 29c-9 0-12 8-6 14-10 15 5 21 14 12 9 5 18-4 8-12 9-7 5-17-4-15"/><path d="M20 47l14-29M14 54l11-5M54 8L39 58"/></>}
  </svg>;
}
function RoleBadge({ role }: { role: RoleId }) { return <span className={`ex-badge ${ROLES[role].instrument}`}><InstrumentIcon instrument={ROLES[role].instrument}/>{ROLES[role].label}<small>{ROLES[role].detail}</small></span>; }

export default function ExhibitionApp() {
  const view = location.pathname === '/stage' ? 'stage' : location.pathname === '/control' ? 'control' : location.pathname === '/admin' ? 'admin' : 'maker';
  const [state, setState] = useState<PublicState | null>(null), [error, setError] = useState(''), [connected, setConnected] = useState(false);
  const [device] = useState(deviceId), [workId, setWorkId] = useState<string | null>(() => sessionStorage.getItem('exhibition-work'));
  const [busy, setBusy] = useState(false), [pin, setPin] = useState(''), [admin, setAdmin] = useState(false);
  const [hasStrokes, setHasStrokes] = useState(false);
  const [toast, setToast] = useState(''), [reset, setReset] = useState(0), [chooser, setChooser] = useState(false);
  const [ready, setReady] = useState(false), [seconds, setSeconds] = useState(0), [previewing, setPreviewing] = useState(false);
  const audio = useRef<EnsembleAudio | null>(null), handled = useRef(''), activePerformance = useRef('');
  const [displayId] = useState(newId);
  const refresh = useCallback(async () => {
    try { const value = await api<PublicState>(`state?deviceId=${device}`); setState(old => old && old.revision > value.revision ? old : old?.revision === value.revision ? { ...old, display: value.display } : value); setConnected(true); }
    catch { setConnected(false); }
  }, [device]);
  useEffect(() => {
    void refresh(); const events = new EventSource('/api/exhibition/events'); events.onmessage = () => void refresh(); events.onerror = () => setConnected(false);
    const timer = setInterval(() => void refresh(), 5000);
    return () => { events.close(); clearInterval(timer); };
  }, [refresh]);
  useEffect(() => () => audio.current?.dispose(), []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 4000); return () => clearTimeout(t); }, [toast]);
  const act = async (route: string, body: unknown, message = '') => { setError(''); try { await api(route, body, view === 'admin' ? pin : undefined); await refresh(); if (message) setToast(message); return true; } catch (e) { setError(e instanceof Error ? e.message : '操作できませんでした'); return false; } };
  const player = () => audio.current ?? (audio.current = new EnsembleAudio());
  const task = state?.tasks.filter(t => t.deviceId === device).at(-1);
  const restoredDrawing = useMemo(() => task?.drawing, [task?.id]);
  const generating = !!task && !['complete', 'failed'].includes(task.status);
  useEffect(() => { if (task?.status === 'complete') { setWorkId(task.workId); sessionStorage.setItem('exhibition-work', task.workId); } }, [task?.id, task?.status]);
  const work = state?.works.find(w => w.id === workId), version = work?.versions.find(v => v.id === work.selectedVersion);
  const joined = state?.members.some(m => m.workId === work?.id && m.versionId === version?.id);
  const stageActive = state?.performance && ['preparing', 'playing'].includes(state.performance.status);
  const members = state?.members ?? [];
  const performing = state?.performance;
  const cards = state ? selectedWorks(state, view === 'stage' && performing && (stageActive || performing.status === 'finished') ? performing.members : members) : [];
  const ordered = [...cards].sort((a, b) => STAGE_ORDER.indexOf(a.member.role) - STAGE_ORDER.indexOf(b.member.role));
  const panFor = (index: number, count: number) => { const columns = count <= 3 ? count : 3; return columns <= 1 ? 0 : (index % columns) / (columns - 1) * 1.3 - .65; };

  useEffect(() => {
    if (view !== 'stage') return;
    let ended = false;
    const heartbeat = async () => {
      try { await api('display', { displayId, ready }); if (!ended) setError(old => old === '別の大画面が接続されています' ? '' : old); }
      catch (e) { if (!ended) { setError(e instanceof Error ? e.message : '大画面の接続が切れました'); setReady(false); audio.current?.stop(); } }
    };
    void heartbeat(); const t = setInterval(() => void heartbeat(), 2500);
    return () => { ended = true; clearInterval(t); };
  }, [view, ready]);
  useEffect(() => {
    if (view !== 'stage' || !state) return;
    const p = state.performance;
    if (!connected || !ready || p?.status === 'stopped') { audio.current?.stop(); activePerformance.current = ''; if (!connected && ready) setReady(false); return; }
    if (!p || p.status !== 'preparing' || handled.current === p.id) return;
    handled.current = p.id; activePerformance.current = p.id;
    const voices = selectedWorks(state, p.members).sort((a,b) => STAGE_ORDER.indexOf(a.member.role) - STAGE_ORDER.indexOf(b.member.role));
    setSeconds(0); setError('');
    void player().play(voices.map((item, i) => ({ version: item.version, pan: panFor(i, voices.length) })), 2, state.volume).then(async started => {
      if (!started || activePerformance.current !== p.id) return;
      await api('ack', { displayId, performanceId: p.id, status: 'playing' });
    }).catch(e => { audio.current?.stop(); setError(e instanceof Error ? e.message : '再生できませんでした'); void api('ack', { displayId, performanceId: p.id, status: 'stopped' }).catch(() => {}); });
  }, [state?.performance?.id, state?.performance?.status, connected, ready]);
  useEffect(() => { if (state && view === 'stage' && audio.current?.active) audio.current.setVolume(state.volume); }, [state?.volume]);
  useEffect(() => {
    let frame = 0, previous = 0;
    const tick = (now: number) => {
      const a = audio.current;
      if (a?.active && now - previous >= 30) {
        previous = now; const elapsed = a.elapsed; setSeconds(Math.min(elapsed, a.duration));
        if (elapsed >= a.duration + .15) {
          a.stop(); setPreviewing(false);
          if (view === 'stage' && activePerformance.current) { const performanceId = activePerformance.current; activePerformance.current = ''; void api('ack', { displayId, performanceId, status: 'finished' }).catch(() => {}); }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [view]);
  const generate = async (drawing?: DrawingData, instrument?: Instrument, existingWork = work?.id) => {
    audio.current?.stop(); setPreviewing(false); setBusy(true); setChooser(false);
    await act('generate', { id: newId(), deviceId: device, ...(drawing ? { drawing } : { workId: existingWork }), instrument }); setBusy(false);
  };
  const preview = async (v: Version) => {
    setError(''); setBusy(true);
    try { setSeconds(0); setPreviewing(await player().play([{ version: v, pan: 0 }], 1, .8, false)); }
    catch (e) { setError(e instanceof Error ? e.message : '再生できませんでした'); } finally { setBusy(false); }
  };
  const currentLine = (time: number) => Math.max(0, Math.min(3, Math.floor(((time % SONG_SECONDS) * FPS - LEAD_FRAMES) / LINE_FRAMES)));
  const lineProgress = (time: number) => Math.max(0, Math.min(1, (((time % SONG_SECONDS) * FPS - LEAD_FRAMES) % LINE_FRAMES) / LINE_FRAMES));
  const lyrics = (w: Work, time: number, playing: boolean) => <div className="ex-lyric"><span>{w.lyrics.lines[playing ? currentLine(time) : 0]}</span>{playing && <span aria-hidden="true" className="ex-lyric-fill" style={{ clipPath: `inset(0 ${100 - lineProgress(time) * 100}% 0 0)` }}>{w.lyrics.lines[currentLine(time)]}</span>}</div>;

  return <div className={`ex-app ex-${view}`}>
    <header className="ex-header"><a href="/"><img src="/logo.png" alt="超えかき歌！"/></a><span className="ex-header-label">みんなの合奏</span><span className={`ex-connection ${connected ? '' : 'offline'}`}>{connected ? 'つながっています' : '接続を確認中'}</span>{view === 'stage' && <button className="ex-fullscreen" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen().catch(() => setError('ブラウザーの全画面表示を使ってください')); }}>全画面 ⛶</button>}{view !== 'stage' && <nav><a href="/">つくる</a><a href="/control">演奏する</a><a href="/admin" aria-label="作品の管理">⚙</a></nav>}</header>
    {error && <div className="ex-error" role="alert">{error}<button onClick={() => setError('')} aria-label="閉じる">×</button></div>}
    {!state ? <div className="ex-loading">展示サーバーにつないでいます…</div> : <>
      {view === 'maker' && <main className="ex-maker-main">
        <div className="ex-intro"><span className="ex-eyebrow">えがいて、うたって、みんなで。</span><h1>{generating ? 'きみの絵が、音になる。' : work ? 'きみの音を、合奏に。' : 'どんな絵が、どんな音になる？'}</h1><p>{generating ? task!.message : work ? 'ヘッドホンで聴いてみよう。準備ができたら、みんなのところへ！' : '好きな絵を描いたら「歌を作る」。楽器は、できてからのお楽しみ。'}</p></div>
        <div className="ex-maker-layout">
          <section className="ex-paper">
            {work && !generating ? <><Drawing drawing={work.drawing} mappings={work.lyrics.lineStrokeMappings} seconds={seconds} complete={!previewing}/>{lyrics(work, seconds, previewing)}</> : <PaintCanvas key={reset} initialDrawing={reset === 0 ? restoredDrawing : undefined} playbackDrawing={generating ? task?.drawing : undefined} onComplete={d => void generate(d)} onClear={() => { setWorkId(null); sessionStorage.removeItem('exhibition-work'); }} isGenerating={generating || busy} generationStageLabel={task?.message} hideFocusControl onDrawingMetricsChange={m => setHasStrokes(m.strokeCount > 0)} guideState={generating || hasStrokes ? null : 'draw'} generationProgressPhase={task?.status === 'voice' ? 'voicevoxQuery' : 'gemini'} />}
          </section>
          <aside className="ex-maker-side">
            {generating ? <section className="ex-card ex-generating"><div className="ex-orbit"><InstrumentIcon instrument={ROLES[task!.role].instrument}/></div><RoleBadge role={task!.role}/><h2>{task!.status === 'lyrics' ? 'ことばを見つけています' : task!.status === 'queued' ? 'もうすぐ、きみの番' : '歌声をつくっています'}</h2><p>{task!.message}</p><div className="ex-progress"><i/></div></section> : work && version ? <section className="ex-card ex-result"><span className="ex-eyebrow">きみの担当は…</span><RoleBadge role={version.role}/><h2>{work.title}</h2><button className="ex-button secondary" disabled={busy} onClick={() => previewing ? (audio.current?.stop(), setPreviewing(false)) : void preview(version)}>{previewing ? '■ 試聴をとめる' : '▶ ヘッドホンで聴く'}</button><button className="ex-button primary" disabled={busy || joined || !connected} onClick={() => { audio.current?.stop(); setPreviewing(false); void act('join', { workId: work.id, versionId: version.id }, '大画面に参加しました！'); }}>{joined ? '✓ 合奏に参加しています' : '＋ 合奏に参加する'}</button>{joined && <p className="ex-success">{stageActive ? '次の演奏から、いっしょに歌うよ。' : '大画面の「演奏する」を待っているよ。'}</p>}<button className="ex-link" onClick={() => setChooser(!chooser)}>楽器を変えてみる ↗</button>{chooser && <div className="ex-instruments">{(['drums','strings','piano'] as Instrument[]).map(i => <button key={i} disabled={busy} onClick={() => void generate(undefined, i)}><InstrumentIcon instrument={i}/>{i === 'drums' ? 'ドラム' : i === 'strings' ? 'ストリングス' : 'ピアノ'}</button>)}<p>絵と歌詞はそのまま。新しい歌い方で作るよ。</p></div>}<button className="ex-link" onClick={() => { audio.current?.stop(); setPreviewing(false); setWorkId(null); sessionStorage.removeItem('exhibition-work'); setReset(x => x + 1); }}>新しい絵を描く →</button></section> : <section className="ex-card ex-invitation"><div className="ex-invitation-icons">{(['drums','strings','piano'] as Instrument[]).map(i => <span key={i} className={i}><InstrumentIcon instrument={i}/></span>)}</div><h2>きみの絵も、<br/>音楽のなかま。</h2><p>ドラム、ストリングス、ピアノ。<br/>どの楽器になるかな？</p><ol><li>絵を描いて、歌を作る</li><li>自分の歌を聴いてみる</li><li>合奏に参加する！</li></ol></section>}
            {task?.status === 'failed' && <section className="ex-card ex-failed"><h3>絵は残っています</h3><p>{task.message}</p><button className="ex-button secondary" onClick={() => void act('retry', { taskId: task.id, deviceId: device })}>もう一度つくる</button></section>}
            <section className="ex-mini-stage"><span>いまの合奏メンバー</span><div>{selectedWorks(state, members).map(({ work: w, version: v }) => <figure key={w.id}><img src={w.drawing.imageUri} alt={w.title}/><InstrumentIcon instrument={ROLES[v.role].instrument}/></figure>)}{!members.length && <p>最初のなかまを待っています</p>}</div><small>{members.length} / 6作品</small></section>
          </aside>
        </div>
      </main>}
      {view === 'stage' && <main className="ex-stage-main">
        <div className="ex-stage-heading"><div><span className="ex-eyebrow">みんなの絵が、ひとつの音楽に。</span><h1>{stageActive ? seconds >= SONG_SECONDS ? 'できた絵と、もういちど。' : 'さあ、みんなで合奏！' : performing?.status === 'finished' ? 'みんなの合奏、できました。' : '音楽のなかま、集合！'}</h1></div><span className="ex-round">{stageActive ? `${seconds >= SONG_SECONDS ? 2 : 1} / 2 周目` : `${members.length} / 6 作品`}</span></div>
        {!ready && <div className="ex-enable"><p>準備ができたら、大画面で一度押してください。</p><button className="ex-button primary" onClick={async () => { try { await player().enable(); setReady(true); setError(''); } catch (e) { setError(String(e)); } }}>音を有効にする</button></div>}
        <div className={`ex-stage-grid count-${ordered.length}`}>
          {ordered.map(({ work: w, version: v }) => <article key={`${w.id}-${v.id}`} className={`ex-performer ${ROLES[v.role].instrument} ${stageActive ? 'playing' : ''}`}><RoleBadge role={v.role}/><div className="ex-performer-art"><Drawing drawing={w.drawing} mappings={w.lyrics.lineStrokeMappings} seconds={seconds} complete={!stageActive || seconds >= SONG_SECONDS}/></div>{lyrics(w, seconds, !!stageActive)}<span className="ex-work-title">{w.title}</span></article>)}
          {!ordered.length && <div className="ex-empty-stage"><div className="ex-invitation-icons">{(['drums','strings','piano'] as Instrument[]).map(i => <span key={i} className={i}><InstrumentIcon instrument={i}/></span>)}</div><h2>どんな絵がやってくるかな？</h2><p>手元の端末で歌を作って「合奏に参加する」を押してね。</p></div>}
        </div>
        <section className="ex-waiting"><div><strong>{stageActive || performing?.status === 'finished' ? '次の演奏のメンバー' : '演奏の準備ができています'}</strong><small>{stageActive ? 'いまの2周が終わったら交代するよ' : '手元のボタンで、合奏をはじめよう'}</small></div><div className="ex-waiting-members">{selectedWorks(state, members).map(({ work: w, version: v }) => <figure key={w.id}><img src={w.drawing.imageUri} alt={w.title}/><span>{ROLES[v.role].detail}</span></figure>)}</div></section>
      </main>}
      {view === 'control' && <main className="ex-control-main"><span className="ex-eyebrow">きみが、合奏のスタート係。</span><h1>みんなの音を<br/>鳴らしてみよう。</h1><p>大画面の絵が、いっしょに歌い出すよ。</p><div className="ex-control-count"><strong>{members.length}</strong><span>作品のなかま</span></div><button className="ex-button primary ex-play-button" disabled={!connected || !state.display.ready || !members.length || !!stageActive} onClick={() => void act('play', {})}>▶ {stageActive ? 'みんなで演奏中' : 'みんなで演奏'}</button><button className="ex-button secondary" disabled={!stageActive} onClick={() => void act('stop', {})}>■ とめる</button><p>{!state.display.connected ? '大画面を開くと、演奏できるようになります。' : !state.display.ready ? '大画面で「音を有効にする」を押してください。' : '2周歌ったら、自動でとまります。'}</p><a className="ex-link" href="/stage" target="_blank" rel="noreferrer">大画面を開く ↗</a></main>}
      {view === 'admin' && <main className="ex-admin-main"><div className="ex-stage-heading"><div><span className="ex-eyebrow">展示の準備と、作品の管理</span><h1>合奏の準備室</h1></div><a className="ex-button secondary" href="/stage" target="_blank" rel="noreferrer">大画面を開く ↗</a></div>{!admin ? <form className="ex-card ex-admin-login" onSubmit={async e => { e.preventDefault(); if (await act('admin', {})) setAdmin(true); }}><label>管理用暗証番号<input type="password" value={pin} onChange={e => setPin(e.target.value)} autoComplete="off"/></label><p>サーバー起動時に表示された番号を入力してください。</p><button className="ex-button primary">管理画面を開く</button></form> : <><section className="ex-card ex-settings"><label>歌声の接続先<select value={state.backend} onChange={e => void act('settings', { backend: e.target.value })}><option value="auto">自動：未来サーバー優先 ＋ Cloud Run</option><option value="vpc">未来サーバー</option><option value="cloud-run">Google Cloud Run</option><option value="local">予備：ローカルVOICEVOX</option></select></label><label>合奏の音量<input type="range" min="0" max="1" step=".05" value={state.volume} onChange={e => void act('settings', { volume: Number(e.target.value) })}/></label><button className="ex-button secondary" onClick={() => void act('import', {}, '過去のデモ記録を確認しました')}>過去のデモ記録を取り込む</button><span>{state.cloudConfigured ? 'クラウド接続設定あり' : 'クラウド接続が未設定'}</span></section><section className="ex-admin-works">{task && (generating || task.status === 'failed') && <div className="ex-card"><p role="status">{task.message}</p>{task.status === 'failed' && <button className="ex-button secondary" onClick={() => void act('retry', { taskId: task.id, deviceId: device })}>もう一度つくる</button>}</div>}{[...state.works].reverse().map(w => { const v = w.versions.find(v => v.id === w.selectedVersion); const member = members.find(m => m.workId === w.id && m.versionId === v?.id); return <article className="ex-card" key={w.id}><img src={w.drawing.imageUri} alt={w.title}/><div><h2>{w.title}</h2>{v ? <RoleBadge role={v.role}/> : <p>合奏用の歌声を作成できます</p>}<small>{new Date(w.createdAt).toLocaleString('ja-JP')}</small><div className="ex-admin-actions">{v && <><button onClick={() => void preview(v)}>試聴</button><button onClick={() => void act(member ? 'leave' : 'join', member ? { workId: w.id } : { workId: w.id, versionId: v.id })}>{member ? '合奏から外す' : '合奏に参加'}</button></>}<select aria-label={`${w.title}の保存した歌`} value={w.selectedVersion} disabled={!w.versions.length} onChange={e => void act('select-version', { workId: w.id, versionId: e.target.value })}>{!w.versions.length && <option value="">保存した歌はありません</option>}{w.versions.map((saved, i) => <option key={saved.id} value={saved.id}>{i + 1}. {ROLES[saved.role].label} · {ROLES[saved.role].detail}</option>)}</select><select aria-label={`${w.title}の楽器を変更`} value="" disabled={generating || busy} onChange={e => void generate(undefined, e.target.value as Instrument, w.id)}><option value="" disabled>楽器を選んで作成…</option><option value="drums">ドラム</option><option value="strings">ストリングス</option><option value="piano">ピアノ</option></select><button className="danger" onClick={() => { if (confirm(`「${w.title}」の保存データを削除しますか？`)) void act('delete', { workId: w.id }); }}>削除</button></div></div></article>; })}{!state.works.length && <p>まだ保存作品がありません。個人端末で歌を作ってみましょう。</p>}</section></>}</main>}
    </>}
    {toast && <div className="ex-toast" role="status">{toast}</div>}
    {view !== 'stage' && <footer className="ex-footer">超えかき歌！ · みんなの合奏 <span>VOICEVOX:ずんだもん</span><a href="/samples/NOTICE.md" target="_blank" rel="noreferrer">音源について</a></footer>}
  </div>;
}
