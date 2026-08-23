import React from "react";
import type { EvaluationCentralConsent } from "../types";

type EvaluationConsentModalProps = {
  open: boolean;
  consent: EvaluationCentralConsent;
  pending: boolean;
  onAccept: () => void;
  onDecline: () => void;
};

/**
 * Presentational only. The caller decides whether a signed receipt and the
 * central-storage feature are available, and later may connect onAccept to a
 * D1 submission service without changing this child-facing copy.
 */
const EvaluationConsentModal: React.FC<EvaluationConsentModalProps> = ({ open, consent, pending, onAccept, onDecline }) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-slate-900/45 px-4 py-5 backdrop-blur-sm" role="presentation">
      <section
        className="max-h-[calc(100svh-2.5rem)] w-full max-w-lg overflow-y-auto rounded-3xl border-4 border-sky-100 bg-white p-5 text-left shadow-2xl sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evaluation-consent-title"
        aria-describedby="evaluation-consent-description"
      >
        <p className="text-xs font-black uppercase tracking-[0.18em] text-sky-500">研究データの保存</p>
        <h2 id="evaluation-consent-title" className="mt-1 text-2xl font-black leading-tight text-gray-800">
          この評価をアプリの改善研究に保存しますか？
        </h2>
        <div id="evaluation-consent-description" className="mt-4 space-y-3 text-sm font-semibold leading-relaxed text-gray-600">
          <p>保存するのは、構造化した描画分析、候補歌詞、表示順、最初の印象の選択、モデル・版・時刻です。</p>
          <p>画像、音声、描画の生データ、氏名、年齢、自由記述は保存しません。</p>
          <p>保存期間と削除方法は、実証実験の案内に従います。拒否しても、生成した歌詞と再生はそのまま使えます。</p>
        </div>
        <p className="mt-4 rounded-2xl bg-sky-50 px-4 py-3 text-xs font-bold leading-relaxed text-sky-900">
          この確認は毎回表示されます。選択はこの生成結果の中央保存にだけ使います。
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button type="button" onClick={onAccept} disabled={pending} autoFocus className="min-h-12 rounded-2xl bg-sky-600 px-4 py-3 text-sm font-black text-white shadow-md transition hover:bg-sky-700 active:scale-95 disabled:cursor-wait disabled:opacity-60">
            {pending ? "保存しています..." : "保存して研究に役立てる"}
          </button>
          <button type="button" onClick={onDecline} disabled={pending} className="min-h-12 rounded-2xl bg-gray-200 px-4 py-3 text-sm font-black text-gray-700 shadow-sm transition hover:bg-gray-300 active:scale-95 disabled:cursor-wait disabled:opacity-60">
            保存しないで続ける
          </button>
        </div>
      </section>
    </div>
  );
};

export default EvaluationConsentModal;
