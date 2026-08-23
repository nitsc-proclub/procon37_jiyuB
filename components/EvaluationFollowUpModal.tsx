import React, { useEffect, useState } from "react";
import type {
  DrawingAnalysisObjectCandidate,
  DrawingSubjectFeedbackChoice,
  EvaluationRatingDimension,
  EvaluationRatingValue,
  EvaluationSelection,
  EvaluationStructuredRatings,
  LyricsCandidate,
} from "../types";

export type EvaluationFollowUpAnswers = {
  finalPreferenceSelection: Exclude<EvaluationSelection, null>;
  subjectFeedbackChoice: DrawingSubjectFeedbackChoice | null;
  ratings: EvaluationStructuredRatings;
};

type EvaluationFollowUpModalProps = {
  open: boolean;
  candidates: [LyricsCandidate, LyricsCandidate];
  objectCandidates: DrawingAnalysisObjectCandidate[];
  initialAnswers: EvaluationFollowUpAnswers;
  canSend: boolean;
  pending: boolean;
  onClose: () => void;
  onSaveLocal: (answers: EvaluationFollowUpAnswers) => void;
  onSend: (answers: EvaluationFollowUpAnswers) => void;
};

const subjectChoiceForIndex = (index: number): DrawingSubjectFeedbackChoice | null =>
  index === 0 ? "primary" : index === 1 ? "alternate-1" : index === 2 ? "alternate-2" : null;

const ratingRows: Array<{ id: EvaluationRatingDimension; label: string }> = [
  { id: "drawingSongQuality", label: "絵描き歌らしい" },
  { id: "drawingOrderClarity", label: "描く順番がわかる" },
  { id: "childFriendliness", label: "子どもにもわかりやすい" },
  { id: "singability", label: "歌いやすい" },
];

const ratingChoices: Array<{ value: EvaluationRatingValue; label: string }> = [
  { value: "good", label: "いい" },
  { value: "okay", label: "ふつう" },
  { value: "needs-work", label: "いまいち" },
];

const EvaluationFollowUpModal: React.FC<EvaluationFollowUpModalProps> = ({
  open,
  candidates,
  objectCandidates,
  initialAnswers,
  canSend,
  pending,
  onClose,
  onSaveLocal,
  onSend,
}) => {
  const [answers, setAnswers] = useState(initialAnswers);

  useEffect(() => {
    if (open) {
      setAnswers({
        finalPreferenceSelection: initialAnswers.finalPreferenceSelection,
        subjectFeedbackChoice: initialAnswers.subjectFeedbackChoice,
        ratings: { ...initialAnswers.ratings },
      });
    }
    // The modal owns a temporary copy while it is open; parent state is only
    // changed by one of the explicit save actions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const visibleSubjectCandidates = objectCandidates.slice(0, 3).flatMap((candidate, index) => {
    const choice = subjectChoiceForIndex(index);
    return choice ? [{ candidate, choice }] : [];
  });

  const toggleRating = (dimension: EvaluationRatingDimension, value: EvaluationRatingValue) => {
    setAnswers((current) => {
      const ratings = { ...current.ratings };
      if (ratings[dimension] === value) delete ratings[dimension];
      else ratings[dimension] = value;
      return { ...current, ratings };
    });
  };

  return (
    <div
      className="fixed inset-0 z-[98] flex items-center justify-center bg-slate-900/45 px-4 py-5 backdrop-blur-sm"
      role="presentation"
      onClick={pending ? undefined : onClose}
    >
      <section
        className="max-h-[calc(100svh-2.5rem)] w-full max-w-2xl overflow-y-auto rounded-3xl border-4 border-violet-100 bg-white p-5 text-left shadow-2xl sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evaluation-follow-up-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-black tracking-[0.12em] text-violet-500">よかったら教えてね</p>
            <h2 id="evaluation-follow-up-title" className="mt-1 text-2xl font-black leading-tight text-gray-800">歌を聞いたあとの感想</h2>
          </div>
          <button type="button" onClick={onClose} disabled={pending} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xl font-black text-gray-500 transition hover:bg-gray-200 disabled:opacity-50" aria-label="閉じる">×</button>
        </div>

        <fieldset className="mt-5">
          <legend className="text-sm font-black text-gray-800">いま好きなのは？</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {candidates.map((candidate) => (
              <button
                key={candidate.candidateId}
                type="button"
                aria-pressed={answers.finalPreferenceSelection === candidate.candidateId}
                onClick={() => setAnswers((current) => ({ ...current, finalPreferenceSelection: candidate.candidateId }))}
                className={`min-h-11 rounded-2xl border-2 px-3 py-2 text-sm font-black transition ${answers.finalPreferenceSelection === candidate.candidateId ? "border-violet-500 bg-violet-500 text-white" : "border-violet-100 bg-violet-50 text-gray-700 hover:border-violet-300"}`}
              >
                {candidate.title}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={answers.finalPreferenceSelection === "neither"}
              onClick={() => setAnswers((current) => ({ ...current, finalPreferenceSelection: "neither" }))}
              className={`min-h-11 rounded-2xl border-2 px-3 py-2 text-sm font-black transition ${answers.finalPreferenceSelection === "neither" ? "border-gray-600 bg-gray-600 text-white" : "border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-400"}`}
            >
              どちらでもない
            </button>
          </div>
          <p className="mt-2 text-xs font-bold text-gray-500">最初に選んだ答えはそのまま残ります。</p>
        </fieldset>

        <fieldset className="mt-6 border-t border-violet-100 pt-5">
          <legend className="text-sm font-black text-gray-800">絵は何に見えた？（任意）</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {visibleSubjectCandidates.map(({ candidate, choice }, index) => (
              <button
                key={choice}
                type="button"
                aria-pressed={answers.subjectFeedbackChoice === choice}
                onClick={() => setAnswers((current) => ({ ...current, subjectFeedbackChoice: current.subjectFeedbackChoice === choice ? null : choice }))}
                className={`min-h-10 rounded-full border px-4 py-2 text-xs font-black transition ${answers.subjectFeedbackChoice === choice ? "border-sky-500 bg-sky-500 text-white" : "border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100"}`}
              >
                {index === 0 ? `合ってた（${candidate.label}）` : candidate.label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={answers.subjectFeedbackChoice === "other"}
              onClick={() => setAnswers((current) => ({ ...current, subjectFeedbackChoice: current.subjectFeedbackChoice === "other" ? null : "other" }))}
              className={`min-h-10 rounded-full border px-4 py-2 text-xs font-black transition ${answers.subjectFeedbackChoice === "other" ? "border-sky-500 bg-sky-500 text-white" : "border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100"}`}
            >
              その他
            </button>
          </div>
        </fieldset>

        <fieldset className="mt-6 border-t border-violet-100 pt-5">
          <legend className="text-sm font-black text-gray-800">歌詞はどうだった？（任意）</legend>
          <div className="mt-3 space-y-3">
            {ratingRows.map((row) => (
              <div key={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <span className="text-sm font-bold text-gray-700">{row.label}</span>
                <div className="grid grid-cols-3 gap-1 rounded-2xl bg-gray-50 p-1">
                  {ratingChoices.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      aria-pressed={answers.ratings[row.id] === choice.value}
                      onClick={() => toggleRating(row.id, choice.value)}
                      className={`min-h-9 rounded-xl px-3 py-1 text-xs font-black transition ${answers.ratings[row.id] === choice.value ? "bg-orange-400 text-white shadow-sm" : "text-gray-600 hover:bg-white"}`}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </fieldset>

        <p className="mt-5 rounded-2xl bg-violet-50 px-4 py-3 text-xs font-bold leading-relaxed text-violet-900">
          {canSend
            ? "「回答を送る」を押すと、ここで選んだ答えを歌詞づくりの改善に使います。絵や音声、自由記述は送りません。"
            : "回答はこの端末だけに保存できます。絵や音声は保存しません。"}
        </p>
        <div className={`mt-4 grid gap-3 ${canSend ? "sm:grid-cols-2" : ""}`}>
          {canSend && (
            <button type="button" onClick={() => onSend(answers)} disabled={pending} className="min-h-12 rounded-2xl bg-violet-600 px-4 py-3 text-sm font-black text-white shadow-md transition hover:bg-violet-700 disabled:cursor-wait disabled:opacity-60">
              {pending ? "送っています..." : "回答を送る"}
            </button>
          )}
          <button type="button" onClick={() => onSaveLocal(answers)} disabled={pending} className="min-h-12 rounded-2xl bg-gray-200 px-4 py-3 text-sm font-black text-gray-700 shadow-sm transition hover:bg-gray-300 disabled:opacity-60">
            端末だけに保存
          </button>
        </div>
      </section>
    </div>
  );
};

export default EvaluationFollowUpModal;
