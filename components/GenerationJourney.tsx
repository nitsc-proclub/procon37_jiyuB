import React from "react";

type GenerationJourneyProps = {
  stageLabel: string;
};

const JOURNEY_STEPS = [
  "絵をじっくり見ているよ",
  "ことばのリズムを整えているよ",
  "メロディーを組み立てているよ",
  "歌声に魔法をかけているよ",
];

const GenerationJourney: React.FC<GenerationJourneyProps> = ({ stageLabel }) => (
  <div className="generation-journey flex h-full min-h-[340px] flex-col items-center justify-center text-center" role="status" aria-live="polite">
    <div className="relative mb-6 h-28 w-28" aria-hidden="true">
      <div className="journey-orbit absolute inset-0 rounded-full border-2 border-violet-300" />
      <div className="journey-orbit journey-orbit-delayed absolute inset-4 rounded-full border-2 border-cyan-300" />
      <div className="absolute inset-0 flex items-center justify-center text-5xl">🌙</div>
      <span className="journey-star absolute left-1 top-3 text-2xl">★</span>
      <span className="journey-star journey-star-delayed absolute bottom-2 right-0 text-xl">♪</span>
    </div>
    <p className="text-2xl font-black text-violet-800">{stageLabel}</p>
    <p className="mt-2 text-sm font-bold text-slate-500">AIとずんだもんが、順番に歌をつくっています</p>
    <div className="mt-6 grid w-full max-w-xl gap-2 sm:grid-cols-2">
      {JOURNEY_STEPS.map((step) => (
        <div key={step} className={`rounded-2xl border px-3 py-2 text-sm font-bold ${step === stageLabel ? "border-violet-400 bg-violet-100 text-violet-900 shadow-md" : "border-violet-100 bg-white/70 text-slate-500"}`}>
          {step === stageLabel ? "✦ " : "○ "}{step}
        </div>
      ))}
    </div>
    <style>{`
      .journey-orbit { animation: journey-spin 4.5s linear infinite; }
      .journey-orbit-delayed { animation-direction: reverse; animation-duration: 3.4s; }
      .journey-star { color: #facc15; animation: journey-float 1.8s ease-in-out infinite; }
      .journey-star-delayed { animation-delay: .6s; color: #a78bfa; }
      @keyframes journey-spin { to { transform: rotate(360deg); } }
      @keyframes journey-float { 50% { transform: translateY(-8px) scale(1.12); } }
      @media (prefers-reduced-motion: reduce) {
        .journey-orbit, .journey-star { animation: none !important; }
      }
    `}</style>
  </div>
);

export default GenerationJourney;
