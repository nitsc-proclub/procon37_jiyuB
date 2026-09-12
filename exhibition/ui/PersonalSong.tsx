import React, { useEffect, useState } from 'react';
import DrawingPlaybackCanvas from '../../components/DrawingPlaybackCanvas';
import KaraokeLyricsPanel from '../../components/KaraokeLyricsPanel';
import { playableVersion, type Work, type Version } from '../shared';
import { RoleBadge } from './Stage';

export default function PersonalSong({ work, version, audioRef, source, onNewSong, children }: {
  key?: string; work: Work; version?: Version; audioRef: React.RefObject<HTMLAudioElement | null>;
  source: (v: Version) => Promise<string>; onNewSong: () => void; children: React.ReactNode;
}) {
  const [url, setUrl] = useState(''), [error, setError] = useState(''), [mode, setMode] = useState<'animated' | 'static'>('animated');
  const [started, setStarted] = useState(false);
  useEffect(() => {
    let disposed = false, generatedUrl = '';
    setUrl(''); setStarted(false); setError('');
    if (version && playableVersion(version)) void source(version).then(value => {
      generatedUrl = value;
      if (disposed) { if (value.startsWith('blob:')) URL.revokeObjectURL(value); return; }
      setUrl(value);
    }).catch(e => { if (!disposed) setError(e instanceof Error ? e.message : '音声を読み込めませんでした'); });
    const element = audioRef.current;
    return () => { disposed = true; element?.pause(); if (generatedUrl.startsWith('blob:')) URL.revokeObjectURL(generatedUrl); };
  }, [version?.id, source]);
  return <div className="ex-maker-layout ex-personal-song">
    <section className="ex-paper ex-personal-art"><DrawingPlaybackCanvas drawingData={work.drawing} audioRef={audioRef} mode={started ? mode : 'static'} lineStrokeMappings={work.lyrics.lineStrokeMappings} singingScore={version?.arrangement.score} lyricLineCount={4}/></section>
    <aside className="ex-maker-side"><section className="ex-card ex-original-result">
      <div className="ex-song-heading">{version && <RoleBadge role={version.role}/>}<h1>{work.title}</h1></div>
      <KaraokeLyricsPanel lyrics={work.lyrics} audioRef={audioRef} singingScore={version?.arrangement.score} showKanaLines={false} className="ex-all-lyrics"/>
      {version && playableVersion(version) && <div className="ex-native-player rounded-3xl border-2 border-yellow-100 bg-yellow-50/80 p-5">
        <div className="ex-drawing-mode"><div className="flex rounded-full bg-white p-1 shadow-sm">{(['animated', 'static'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} className={`rounded-full px-4 py-2 text-sm font-black transition-all ${mode === value ? 'bg-orange-400 text-white shadow-sm' : 'text-gray-500'}`}>{value === 'animated' ? 'アニメーション' : '完成絵'}</button>)}</div></div>
        <audio ref={audioRef} src={url || undefined} controls preload="auto" aria-label="歌声の再生" onPlay={() => setStarted(true)} onError={() => { if (url) setError('音声を読み込めませんでした'); }}/>
      </div>}
      {error && <p className="ex-playback-error" role="alert">{error}</p>}
      {children}
    </section><button type="button" onClick={onNewSong} className="new-song-action min-h-12 w-full rounded-2xl border-2 border-orange-200 bg-orange-50 px-4 py-3 text-base font-black text-orange-700 shadow-sm transition hover:border-orange-300 hover:bg-orange-100 active:scale-[.98]">新しい歌を作る</button></aside>
  </div>;
}
