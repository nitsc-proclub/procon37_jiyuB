import React, { useEffect, useRef } from "react";

export type CompletionDoorState = "ready" | "opening" | "open";

type CompletionDoorProps = {
  state: CompletionDoorState;
  onOpen: () => void;
};

const CompletionDoor: React.FC<CompletionDoorProps> = ({ state, onOpen }) => {
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (state === "ready") buttonRef.current?.focus();
  }, [state]);

  if (state === "open") return null;

  const isOpening = state === "opening";

  return (
    <div
      className="absolute inset-0 z-40 overflow-hidden rounded-2xl bg-yellow-50"
      role="dialog"
      aria-modal="true"
      aria-label="うたの扉"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        event.preventDefault();
        buttonRef.current?.focus();
      }}
    >
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {isOpening ? "うたの扉を開いています" : "うたができました。扉を開いて聞いてみましょう"}
      </p>
      <button
        ref={buttonRef}
        type="button"
        onClick={onOpen}
        disabled={isOpening}
        className="relative flex h-full min-h-[360px] w-full items-center justify-center overflow-hidden rounded-2xl focus-visible:outline focus-visible:outline-4 focus-visible:outline-orange-500 focus-visible:outline-offset-[-6px]"
        aria-label={isOpening ? "うたの扉を開いています" : "うたの扉を開いて歌を聞く"}
      >
        <span className={`completion-door-panel absolute inset-y-0 left-0 w-1/2 border-r-2 border-orange-200 bg-gradient-to-br from-yellow-100 via-white to-orange-100 ${isOpening ? "completion-door-left-open" : ""}`} aria-hidden="true" />
        <span className={`completion-door-panel absolute inset-y-0 right-0 w-1/2 border-l-2 border-orange-200 bg-gradient-to-bl from-yellow-100 via-white to-orange-100 ${isOpening ? "completion-door-right-open" : ""}`} aria-hidden="true" />
        <span className={`relative z-10 mx-5 rounded-[2rem] border-4 border-yellow-300 bg-white/95 px-8 py-8 text-center shadow-2xl transition-opacity duration-200 ${isOpening ? "opacity-0" : "opacity-100"}`}>
          <span className="block text-5xl" aria-hidden="true">🎵</span>
          <span className="mt-3 block text-3xl font-black text-orange-700">うたが できたよ！</span>
          <span className="mt-3 block text-lg font-black text-slate-700">タップして とびらを あけよう</span>
          <span className="mt-4 inline-flex min-h-14 items-center rounded-full bg-orange-500 px-7 text-lg font-black text-white shadow-lg">あける</span>
        </span>
        {isOpening && <span className="relative z-10 rounded-full bg-white/90 px-5 py-3 text-xl font-black text-orange-700 shadow-lg">♪ とびらが ひらくよ</span>}
      </button>
      <style>{`
        .completion-door-panel { transition: transform 420ms cubic-bezier(.22,.8,.3,1); }
        .completion-door-left-open { transform: translateX(-102%); }
        .completion-door-right-open { transform: translateX(102%); }
        @media (prefers-reduced-motion: reduce) {
          .completion-door-panel { transition-duration: 1ms; }
        }
      `}</style>
    </div>
  );
};

export default CompletionDoor;
