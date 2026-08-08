import React, { useEffect, useRef } from "react";

interface DebugExportDialogProps {
  hasLyrics: boolean;
  hasScore: boolean;
  hasVoice: boolean;
  hasError: boolean;
  reporterNote: string;
  isDownloading: boolean;
  downloadError: string | null;
  onReporterNoteChange: (value: string) => void;
  onClose: () => void;
  onDownload: () => void;
}

const DebugExportDialog: React.FC<DebugExportDialogProps> = ({
  hasLyrics,
  hasScore,
  hasVoice,
  hasError,
  reporterNote,
  isDownloading,
  downloadError,
  onReporterNoteChange,
  onClose,
  onDownload,
}) => {
  const downloadButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    downloadButtonRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 px-4 py-6 backdrop-blur-sm"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="w-full max-w-lg rounded-3xl border-4 border-violet-100 bg-white p-5 text-left shadow-2xl sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="debug-export-title"
        aria-describedby="debug-export-description"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !isDownloading) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <p className="text-xs font-black uppercase tracking-[0.18em] text-violet-500">Debug bundle</p>
        <h2 id="debug-export-title" className="mt-1 text-2xl font-black text-gray-800">
          共有用のZIPを作成します
        </h2>
        <p id="debug-export-description" className="mt-3 text-sm font-semibold leading-relaxed text-gray-600">
          バグ報告の相手が同じ生成結果を調べられるように、今回のデータだけを1つのZIPにまとめます。
        </p>

        <div className="mt-4 rounded-2xl border border-violet-100 bg-violet-50/70 p-4 text-sm font-semibold leading-relaxed text-gray-700">
          <p className="font-black text-violet-800">ZIPに含めるもの</p>
          <ul className="mt-2 list-inside list-disc space-y-1">
            <li>入力画像、描画ストローク、キャンバス設定</li>
            <li>生成した歌詞: {hasLyrics ? "あり" : "なし（Geminiの失敗情報を記録）"}</li>
            <li>楽譜データ: {hasScore ? "あり" : "なし"}</li>
            <li>VOICEVOXの実歌声: {hasVoice ? "あり（voice.wav）" : "なし"}</li>
            {hasError && <li>今回表示されたエラー情報</li>}
          </ul>
        </div>

        <div className="mt-3 rounded-2xl bg-gray-50 p-4 text-xs font-bold leading-relaxed text-gray-600">
          APIキー、Cloudflareの認証情報、メールアドレス、年齢、VOICEVOXの接続URL、無音アニメーション用WAVは含めません。
          描画やメモに個人情報がないかを確認してから共有してください。
        </div>

        <label className="mt-4 block text-sm font-black text-gray-700">
          問題メモ（任意）
          <textarea
            value={reporterNote}
            onChange={(event) => onReporterNoteChange(event.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="例: 2行目の歌詞と丸い部分のストロークが対応していないように見えます"
            className="mt-2 block w-full resize-y rounded-2xl border-2 border-violet-100 bg-white px-3 py-2 text-sm font-semibold text-gray-700 outline-none transition focus:border-violet-400 focus:ring-4 focus:ring-violet-100"
          />
        </label>

        {downloadError && (
          <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700" role="alert">
            {downloadError}
          </p>
        )}

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button
            ref={downloadButtonRef}
            type="button"
            onClick={onDownload}
            disabled={isDownloading}
            className="flex h-12 items-center justify-center rounded-2xl bg-violet-600 px-4 text-sm font-black text-white shadow-md transition hover:bg-violet-700 active:scale-95 disabled:cursor-wait disabled:opacity-60"
          >
            {isDownloading ? "ZIPを作成中..." : "ZIPをダウンロード"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={isDownloading}
            className="flex h-12 items-center justify-center rounded-2xl bg-gray-200 px-4 text-sm font-black text-gray-700 transition hover:bg-gray-300 active:scale-95 disabled:opacity-60"
          >
            キャンセル
          </button>
        </div>
      </section>
    </div>
  );
};

export default DebugExportDialog;
