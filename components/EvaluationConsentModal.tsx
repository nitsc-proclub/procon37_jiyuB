import React, { useEffect, useRef } from "react";
type EvaluationConsentModalProps = {
  open: boolean;
  pending: boolean;
  savesInBrowser: boolean;
  savesToCloud: boolean;
  savesFullArchive?: boolean;
  onAccept: () => void;
  onDecline: () => void;
};

/**
 * Presentational only. The caller decides whether a signed receipt and the
 * central-storage feature are available and handles the D1 submission.
 */
const EvaluationConsentModal: React.FC<EvaluationConsentModalProps> = ({ open, pending, savesInBrowser, savesToCloud, savesFullArchive = false, onAccept, onDecline }) => {
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onDeclineRef = useRef(onDecline);
  const pendingRef = useRef(pending);
  onDeclineRef.current = onDecline;
  pendingRef.current = pending;
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingRef.current) { event.preventDefault(); onDeclineRef.current(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [])]
        .filter((item) => !item.hasAttribute("disabled"));
      if (!focusable.length) return;
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); focusable.at(-1)?.focus(); }
      else if (!event.shiftKey && index === focusable.length - 1) { event.preventDefault(); focusable[0]?.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { window.clearTimeout(timer); document.removeEventListener("keydown", onKeyDown); returnFocusRef.current?.focus(); };
  }, [open]);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-slate-900/45 px-4 py-5 backdrop-blur-sm" role="presentation">
      <section
        ref={dialogRef}
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
          {savesToCloud && savesFullArchive && <p><span className="font-black text-gray-800">クラウド：</span>絵・描いた線・2つの歌・回答を、改善のため1年間保存します。</p>}
          {savesToCloud && !savesFullArchive && <p><span className="font-black text-gray-800">クラウド：</span>絵の分析・2つの歌詞・選んだ答えを、アプリの改善に使います。</p>}
          {savesToCloud && savesFullArchive && <p className="text-xs">非公開です。保護者の方が確認し、このブラウザから削除できます。</p>}
          {savesToCloud && !savesFullArchive && <p className="text-xs">改善用には、絵・歌声・描いた線を保存しません。</p>}
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
