import React, { useEffect, useRef, useState } from 'react';
import { FPS, LEAD_FRAMES, LINE_FRAMES, SONG_SECONDS, ROLES, type Work, type RoleId, type selectedWorks } from '../shared';
import Drawing, { drawingBounds } from './Drawing';
import type { CurtainPhase } from './curtain';
import background from '../assets/stage-background.png';

export function RoleBadge({ role }: { role: RoleId }) {
  return <span className={`ex-badge ${ROLES[role].instrument} role-${role}`}><span aria-hidden="true">{ROLES[role].emoji}</span>{ROLES[role].label}<small>{ROLES[role].detail}</small></span>;
}

// The audio clock drives canvas and lyric highlighting directly. React only updates at line boundaries.
export function LiveLyric({ work, clock, playing }: { work: Work; clock: () => number; playing: boolean }) {
  const [line, setLine] = useState(0), fill = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!playing) { setLine(0); if (fill.current) Array.from(fill.current.children).forEach(child => (child as HTMLElement).classList.remove('is-sung')); return; }
    let frame = 0;
    const tick = () => {
      const elapsed = Math.max(0, clock() % SONG_SECONDS * FPS - LEAD_FRAMES);
      const nextLine = Math.min(3, Math.floor(elapsed / LINE_FRAMES));
      if (line !== nextLine) setLine(nextLine);
      if (fill.current) {
        const sung = Math.floor((elapsed % LINE_FRAMES) / LINE_FRAMES * fill.current.children.length);
        Array.from(fill.current.children).forEach((child, i) => (child as HTMLElement).classList.toggle('is-sung', i < sung));
      }
      frame = requestAnimationFrame(tick);
    };
    tick(); return () => cancelAnimationFrame(frame);
  }, [clock, playing, line]);
  return <div className="ex-lyric"><span ref={fill}>{Array.from(work.lyrics.lines[playing ? line : 0]).map((letter, i) => <span key={`${line}-${i}`} className="ex-lyric-letter">{letter}</span>)}</span></div>;
}

function FitTitle({ title }: { title: string }) {
  const box = useRef<HTMLHeadingElement>(null), probe = useRef<HTMLSpanElement>(null), text = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const resize = () => {
      if (!box.current || !probe.current || !text.current) return;
      const base = parseFloat(getComputedStyle(probe.current).fontSize);
      const fitted = Math.min(base, base * (box.current.clientWidth - 4) / Math.max(1, probe.current.getBoundingClientRect().width));
      text.current.style.fontSize = `${Math.floor(fitted * 10) / 10}px`;
    };
    const observer = new ResizeObserver(resize); observer.observe(box.current!); resize();
    void document.fonts.ready.then(resize);
    return () => observer.disconnect();
  }, [title]);
  return <h2 ref={box} title={title} className="ex-fitted-title"><span ref={probe} aria-hidden="true" className="ex-title-probe">{title}</span><span ref={text}>{title}</span></h2>;
}

function Sparkles() {
  return <div className="ex-sparkles" aria-hidden="true">{Array.from({ length: 28 }, (_, i) => <span key={i} style={{ '--spark': i, left: `${(i * 37 + 7) % 96}%`, top: `${(i * 23 + 12) % 87}%` } as React.CSSProperties}>{i % 5 === 0 ? '♪' : i % 3 === 0 ? '✧' : '✦'}</span>)}</div>;
}

type Cards = ReturnType<typeof selectedWorks>;
export function MiniStage({ cards, label = '合奏のなかま' }: { cards: Cards; label?: string }) {
  return <aside className="ex-mini-stage"><strong>{label}</strong><div>{cards.map(({ work, version }) => <a key={work.id} href={`/?work=${encodeURIComponent(work.id)}`} title={`${work.title} · ${ROLES[version.role].label}`}><img src={work.drawing.imageUri} alt={work.title}/></a>)}{!cards.length && <span>まだいません</span>}</div></aside>;
}

export default function Stage({ cards, next, clock, playing, curtain, limit }: { cards: Cards; next: Cards; clock: () => number; playing: boolean; curtain: CurtainPhase; limit: number }) {
  const waiting = playing && (cards.length !== next.length || cards.some(c => !next.some(n => n.version.id === c.version.id)));
  return <main className={`ex-stage-main ${playing ? 'is-playing' : ''} count-${cards.length}`} style={{ backgroundImage: `url(${background})` }}>
    <Sparkles/>{!playing && <span className="ex-round">{cards.length} / {limit} 人</span>}
    <div className="ex-ensemble" style={{ '--players': Math.max(1, cards.length) } as React.CSSProperties}>
      {cards.map(({ work, version }, i) => { const bounds = drawingBounds(work.drawing); return <article key={version.id} className={`ex-performer ${ROLES[version.role].instrument} role-${version.role}`} style={{ '--index': i, '--shadow-width': `${Math.max(22, bounds.width / Math.max(bounds.width, bounds.height) * 86)}%` } as React.CSSProperties}>
        <div className="ex-performer-heading"><FitTitle title={work.title}/></div>
        <div className="ex-speech"><LiveLyric work={work} clock={clock} playing={playing}/></div>
        <div className="ex-performer-art"><span className="ex-role-icon" role="img" aria-label={ROLES[version.role].label} title={`${ROLES[version.role].label} · ${ROLES[version.role].detail}`}>{ROLES[version.role].emoji}</span><div className="ex-art-anchor"><span className="ex-floor-shadow" aria-hidden="true"/><div className="ex-dancer"><Drawing drawing={work.drawing} mappings={work.lyrics.lineStrokeMappings} clock={playing ? clock : undefined} complete={!playing} loop/></div></div></div>
        <div className="ex-notes" aria-hidden="true">{['♪', '♫', '♪', '♬', '♪'].map((note, n) => <span key={n} style={{ '--note': n } as React.CSSProperties}>{note}</span>)}</div>
      </article>; })}
      {!cards.length && <div className="ex-empty-stage"><span aria-hidden="true">♪ 🎤 ♫</span></div>}
    </div>
    {waiting && <div className="ex-stage-bottom"><MiniStage cards={next} label="つぎの合奏"/></div>}
    <div className={`ex-curtain curtain-${curtain}`} aria-hidden={curtain === 'idle'}><div className="ex-curtain-panel left"/><div className="ex-curtain-panel right"/><div className="ex-curtain-cue" role="status">{curtain === 'closed' && <><span aria-hidden="true">♪</span> スタート！ <span aria-hidden="true">♪</span></>}</div></div>
  </main>;
}
