import React, { useRef, useState } from "react";
import { DrawingData, LyricsResponse, SingingScore } from "../types";

type TransformationStorybookProps = {
  drawingData: DrawingData;
  lyrics: LyricsResponse;
  singingScore?: SingingScore | null;
  onReturnToSong: (playFromStart: boolean) => void;
};

const TransformationStorybook: React.FC<TransformationStorybookProps> = ({ drawingData, lyrics, singingScore, onReturnToSong }) => {
  const [activeChapter, setActiveChapter] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);
  const noteCount = singingScore?.notes.filter((note) => note.key !== null).length ?? 0;
  const chapters = [
    { icon: "✏️", title: "線が うまれた", body: `${drawingData.strokes.length}本の線を、描いた順番におぼえているよ。` },
    { icon: "💬", title: "ことばに なった", body: lyrics.lines.filter(Boolean).join("　♪　") },
    { icon: "🎼", title: "音符が ならんだ", body: noteCount > 0 ? `${noteCount}この音が、ことばのリズムに並んだよ。` : "ことばの長さから、歌のリズムが生まれたよ。" },
    { icon: "🎤", title: "絵が うたいだす", body: `「${lyrics.title}」のできあがり！` },
  ];

  const goToChapter = (index: number) => {
    const next = Math.max(0, Math.min(chapters.length - 1, index));
    setActiveChapter(next);
    sectionRefs.current[next]?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  };

  const handleScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const targetTop = scroller.getBoundingClientRect().top + Math.min(scroller.clientHeight * 0.42, 280);
    const closest = sectionRefs.current.reduce((best, section, index) => {
      if (!section) return best;
      const distance = Math.abs(section.getBoundingClientRect().top - targetTop);
      return distance < best.distance ? { index, distance } : best;
    }, { index: 0, distance: Number.POSITIVE_INFINITY });
    setActiveChapter(closest.index);
  };

  return (
    <section aria-labelledby="storybook-title">
      <h3 id="storybook-title" className="mb-3 text-center text-2xl font-black text-slate-800">スクロール変身絵本</h3>
      <div ref={scrollerRef} onScroll={handleScroll} className="storybook-scroll max-h-[70vh] overflow-y-auto rounded-3xl border-4 border-yellow-200 bg-[#fffdf7] scroll-smooth snap-y snap-mandatory">
        <div className="sticky top-0 z-10 flex justify-center border-b-2 border-yellow-100 bg-white/95 p-2 backdrop-blur-sm">
          <img src={drawingData.imageUri} alt="変身していく自分の絵" className="storybook-image aspect-square w-full max-w-xs object-contain" />
        </div>
        {chapters.map((chapter, index) => (
          <section
            key={chapter.title}
            ref={(node) => { sectionRefs.current[index] = node; }}
            aria-current={index === activeChapter ? "step" : undefined}
            className="flex min-h-[17rem] snap-start flex-col items-center justify-center border-b-2 border-yellow-100 px-5 py-8 text-center scroll-mt-[12rem]"
          >
            <span className="text-5xl" aria-hidden="true">{chapter.icon}</span>
            <p className="mt-3 text-xs font-black text-orange-700">だい {index + 1} しょう {index === activeChapter && <span className="ml-2 rounded-full bg-orange-600 px-2 py-1 text-white">いまここ</span>}</p>
            <h4 className="mt-3 text-2xl font-black text-slate-800">{chapter.title}</h4>
            <p className="mt-3 max-w-md font-bold leading-relaxed text-slate-600">{chapter.body}</p>
            {index === chapters.length - 1 && (
              <div className="mt-5 grid w-full max-w-sm gap-2 sm:grid-cols-2">
                <button type="button" onClick={() => onReturnToSong(false)} className="min-h-11 rounded-2xl bg-slate-100 px-4 font-black text-slate-700">うた画面へ</button>
                <button type="button" onClick={() => onReturnToSong(true)} className="min-h-11 rounded-2xl bg-orange-500 px-4 font-black text-white">最初から聞く ♪</button>
              </div>
            )}
          </section>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <button type="button" onClick={() => goToChapter(activeChapter - 1)} disabled={activeChapter === 0} className="min-h-11 rounded-2xl bg-slate-100 px-4 font-black text-slate-700 disabled:opacity-40">← まえの章</button>
        <button type="button" onClick={() => goToChapter(activeChapter + 1)} disabled={activeChapter === chapters.length - 1} className="min-h-11 rounded-2xl bg-orange-500 px-4 font-black text-white disabled:opacity-40">つぎの章 →</button>
      </div>
      <style>{`
        .storybook-image { max-height: min(36vh, 18rem); }
        @media (max-width: 480px) {
          .storybook-scroll { max-height: 68vh; }
          .storybook-image { max-height: min(24vh, 11rem); }
        }
        @media (prefers-reduced-motion: reduce) {
          .storybook-scroll { scroll-behavior: auto; }
        }
      `}</style>
    </section>
  );
};

export default TransformationStorybook;
