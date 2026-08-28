import React from "react";
type EvaluationConsentModalProps = {
  open: boolean;
  pending: boolean;
  savesInBrowser: boolean;
  savesToCloud: boolean;
  onAccept: () => void;
  onDecline: () => void;
};

/**
 * Presentational only. The caller decides whether a signed receipt and the
 * central-storage feature are available and handles the D1 submission.
 */
const EvaluationConsentModal: React.FC<EvaluationConsentModalProps> = ({ open, pending, savesInBrowser, savesToCloud, onAccept, onDecline }) => {
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
        <p className="text-xs font-black tracking-[0.18em] text-sky-500">今回の歌</p>
        <h2 id="evaluation-consent-title" className="mt-1 text-2xl font-black leading-tight text-gray-800">
          この歌を保存してもいい？
        </h2>
        <div id="evaluation-consent-description" className="mt-4 space-y-2 text-sm font-semibold leading-relaxed text-gray-600">
          {savesInBrowser && <p><span className="font-black text-gray-800">このブラウザ：</span>絵と歌を、あとで開けるように保存します。</p>}
          {savesToCloud && <p><span className="font-black text-gray-800">クラウド：</span>絵の分析・2つの歌詞・選んだ答えを、アプリの改善に使います。</p>}
          {savesToCloud && <p className="text-xs">クラウドに絵・歌声・描いた線・名前・年齢は送りません。</p>}
        </div>
        <p className="mt-4 rounded-2xl bg-sky-50 px-4 py-3 text-xs font-bold leading-relaxed text-sky-900">
          保存しなくても、できた歌はそのまま使えます。
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button type="button" onClick={onAccept} disabled={pending} autoFocus className="min-h-12 rounded-2xl bg-sky-600 px-4 py-3 text-sm font-black text-white shadow-md transition hover:bg-sky-700 active:scale-95 disabled:cursor-wait disabled:opacity-60">
            {pending ? "保存しています..." : "保存してつづける"}
          </button>
          <button type="button" onClick={onDecline} disabled={pending} className="min-h-12 rounded-2xl bg-gray-200 px-4 py-3 text-sm font-black text-gray-700 shadow-sm transition hover:bg-gray-300 active:scale-95 disabled:cursor-wait disabled:opacity-60">
            保存せずつづける
          </button>
        </div>
      </section>
    </div>
  );
};

export default EvaluationConsentModal;
