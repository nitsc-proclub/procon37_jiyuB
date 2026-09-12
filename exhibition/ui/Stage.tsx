import React, { useEffect, useRef, useState } from 'react';
import { FPS, LEAD_FRAMES, LINE_FRAMES, SONG_SECONDS, ROLES, type Work, type RoleId, type selectedWorks } from '../shared';
import Drawing from './Drawing';
import background from '../assets/stage-background.png';

export function RoleBadge({ role }: { role: RoleId }) {
  return <span className={`ex-badge ${ROLES[role].instrument}`}>{ROLES[role].label}<small>{ROLES[role].detail}</small></span>;
}

// The audio clock drives canvas and lyric highlighting directly. React only updates at line boundaries.
export function LiveLyric({ work, clock, playing }: { work: Work; clock: () => number; playing: boolean }) {
  const [line, setLine] = useState(0), fill = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!playing) { setLine(0); return; }
    let frame = 0, previousLine = -1;
    const tick = () => {
      const elapsed = Math.max(0, clock() % SONG_SECONDS * FPS - LEAD_FRAMES);
      const nextLine = Math.min(3, Math.floor(elapsed / LINE_FRAMES));
      if (previousLine !== nextLine) { previousLine = nextLine; setLine(nextLine); }
      if (fill.current) fill.current.style.clipPath = `inset(0 ${100 - elapsed % LINE_FRAMES / LINE_FRAMES * 100}% 0 0)`;
      frame = requestAnimationFrame(tick);
    };
    tick(); return () => cancelAnimationFrame(frame);
  }, [clock, playing]);
  return <div className="ex-lyric"><span>{work.lyrics.lines[line]}</span>{playing && <span ref={fill} aria-hidden="true" className="ex-lyric-fill">{work.lyrics.lines[line]}</span>}</div>;
}

type Cards = ReturnType<typeof selectedWorks>;
export function MiniStage({ cards, label = '合奏のなかま' }: { cards: Cards; label?: string }) {
  return <aside className="ex-mini-stage"><strong>{label}</strong><div>{cards.map(({ work, version }) => <a key={work.id} href={`/?work=${encodeURIComponent(work.id)}`} title={`${work.title} · ${ROLES[version.role].label}`}><img src={work.drawing.imageUri} alt={work.title}/></a>)}{!cards.length && <span>まだいません</span>}</div></aside>;
}

export default function Stage({ cards, next, clock, playing, finished, limit }: { cards: Cards; next: Cards; clock: () => number; playing: boolean; finished: boolean; limit: number }) {
  const [round, setRound] = useState(1);
  useEffect(() => {
    if (!playing) { setRound(1); return; }
    const timer = setInterval(() => setRound(clock() >= SONG_SECONDS ? 2 : 1), 80);
    return () => clearInterval(timer);
  }, [playing, clock]);
  const waiting = playing && (cards.length !== next.length || cards.some(c => !next.some(n => n.version.id === c.version.id)));
  return <main className={`ex-stage-main ${playing ? 'is-playing' : ''} count-${cards.length}`} style={{ backgroundImage: `url(${background})` }}>
    <div className="ex-stage-heading"><h1>{playing ? 'みんなで合奏！' : finished ? 'すてきな合奏！' : '音楽のなかま、あつまれ！'}</h1><span className="ex-round">{playing ? `${round} / 2 周` : `${cards.length} / ${limit} 人`}</span></div>
    <div className="ex-ensemble" style={{ '--players': Math.max(1, cards.length) } as React.CSSProperties}>
      {cards.map(({ work, version }, i) => <article key={version.id} className={`ex-performer ${ROLES[version.role].instrument} role-${version.role}`} style={{ '--index': i } as React.CSSProperties}>
        <div className="ex-performer-heading"><RoleBadge role={version.role}/><h2>{work.title}</h2></div>
        <div className="ex-speech"><LiveLyric work={work} clock={clock} playing={playing}/></div>
        <div className="ex-performer-art"><div className="ex-dancer"><Drawing drawing={work.drawing} mappings={work.lyrics.lineStrokeMappings} clock={playing ? clock : undefined} complete={!playing}/></div></div>
        <div className="ex-notes" aria-hidden="true">{['♪', '♫', '♪', '♬', '♪'].map((note, n) => <span key={n} style={{ '--note': n } as React.CSSProperties}>{note}</span>)}</div>
      </article>)}
      {!cards.length && <div className="ex-empty-stage"><span aria-hidden="true">♪</span><h2>きみの絵を待ってるよ</h2></div>}
    </div>
    <div className="ex-stage-bottom">{waiting ? <MiniStage cards={next} label="つぎの合奏"/> : <div className="ex-stage-lineup">{cards.map(({ version }) => <div key={version.id} className={`${ROLES[version.role].instrument} role-${version.role}`}><i aria-hidden="true"/>{ROLES[version.role].label}<small>{ROLES[version.role].detail}</small></div>)}</div>}</div>
  </main>;
}
