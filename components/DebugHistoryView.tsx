import React, { useEffect, useMemo, useRef, useState } from "react";
import DrawingPlaybackCanvas from "./DrawingPlaybackCanvas";
import KaraokeLyricsPanel from "./KaraokeLyricsPanel";
import { createDebugBundleFromArtifacts, downloadDebugBundle } from "../services/debugBundleService";
import { importDebugBundle } from "../services/debugBundleImportService";
import {
  clearDebugHistoryRecords,
  createDebugHistoryRecord,
  DebugHistoryRecord,
  DebugHistoryRecordSummary,
  DebugHistoryStats,
  deleteDebugHistoryRecord,
  getDebugHistoryRecord,
  getDebugHistoryStats,
  listDebugHistoryRecords,
  saveDebugHistoryRecord,
} from "../services/debugHistoryDb";
import { createSilentPlaybackAudio } from "../services/silentPlaybackService";
import { DrawingData } from "../types";

interface DebugHistoryViewProps {
  /** Opens a replayable, saved record in the maker. Imported ZIP previews stay here. */
  onOpenRecord: (record: DebugHistoryRecord) => void;
  onBack: () => void;
  onToast: (message: string, tone: "success" | "error") => void;
}

type DebugBrowseMode = "drawings" | "songs";

const formatBytes = (value: number) => {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

const outcomeLabel = (status: DebugHistoryRecordSummary["manifest"]["outcome"]["status"]) =>
  status === "success" ? "成功" : status === "partial" ? "一部完了" : "エラー";

const outcomeClass = (status: DebugHistoryRecordSummary["manifest"]["outcome"]["status"]) =>
  status === "success" ? "bg-emerald-100 text-emerald-700" : status === "partial" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700";

const DebugHistoryView: React.FC<DebugHistoryViewProps> = ({ onOpenRecord, onBack, onToast }) => {
  const [records, setRecords] = useState<DebugHistoryRecordSummary[]>([]);
  const [stats, setStats] = useState<DebugHistoryStats | null>(null);
  const [selected, setSelected] = useState<DebugHistoryRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingRecordId, setLoadingRecordId] = useState<string | null>(null);
  const [actionRecordId, setActionRecordId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const [browseMode, setBrowseMode] = useState<DebugBrowseMode>("drawings");
  const [importedPreviewRecordId, setImportedPreviewRecordId] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextRecords, nextStats] = await Promise.all([listDebugHistoryRecords(), getDebugHistoryStats()]);
      setRecords(nextRecords);
      setStats(nextStats);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "履歴を読み込めませんでした。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selected) {
      setImageUrl(null);
      setAudioUrl(null);
      return;
    }

    const nextImageUrl = URL.createObjectURL(selected.artifacts.imageBlob);
    const nextAudioBlob = selected.artifacts.voiceAudioBlob ?? (selected.manifest.singingScore ? createSilentPlaybackAudio(selected.manifest.singingScore) : null);
    const nextAudioUrl = nextAudioBlob ? URL.createObjectURL(nextAudioBlob) : null;
    setImageUrl(nextImageUrl);
    setAudioUrl(nextAudioUrl);

    return () => {
      URL.revokeObjectURL(nextImageUrl);
      if (nextAudioUrl) URL.revokeObjectURL(nextAudioUrl);
    };
  }, [selected]);

  useEffect(() => {
    let disposed = false;
    const createdUrls: string[] = [];

    const loadThumbnails = async () => {
      const entries = await Promise.all(records.map(async (record) => {
        try {
          const fullRecord = await getDebugHistoryRecord(record.recordId);
          if (!fullRecord) return null;
          const thumbnailUrl = URL.createObjectURL(fullRecord.artifacts.imageBlob);
          if (disposed) {
            URL.revokeObjectURL(thumbnailUrl);
            return null;
          }
          createdUrls.push(thumbnailUrl);
          return [record.recordId, thumbnailUrl] as const;
        } catch {
          return null;
        }
      }));

      if (!disposed) {
        setThumbnailUrls(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== null)));
      }
    };

    void loadThumbnails();
    return () => {
      disposed = true;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [records]);

  const selectRecord = async (recordId: string) => {
    setLoadingRecordId(recordId);
    setError(null);
    try {
      const record = await getDebugHistoryRecord(recordId);
      if (!record) {
        setSelected(null);
        setImportedPreviewRecordId(null);
        await refresh();
        return;
      }

      setSelected(null);
      setImportedPreviewRecordId(null);
      onOpenRecord(record);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "履歴の詳細を読み込めませんでした。");
    } finally {
      setLoadingRecordId(null);
    }
  };

  const deleteRecord = async (recordId: string) => {
    if (!window.confirm("このデバッグ履歴を削除しますか？ この操作は元に戻せません。")) return;
    setActionRecordId(recordId);
    try {
      await deleteDebugHistoryRecord(recordId);
      if (selected?.recordId === recordId) {
        audioRef.current?.pause();
        setSelected(null);
      }
      await refresh();
      onToast("デバッグ履歴を削除しました。", "success");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "履歴を削除できませんでした。");
    } finally {
      setActionRecordId(null);
    }
  };

  const clearRecords = async () => {
    if (!window.confirm("このブラウザのデバッグ履歴をすべて削除しますか？ この操作は元に戻せません。")) return;
    setActionRecordId("all");
    try {
      audioRef.current?.pause();
      await clearDebugHistoryRecords();
      setSelected(null);
      await refresh();
      onToast("デバッグ履歴をすべて削除しました。", "success");
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "履歴を削除できませんでした。");
    } finally {
      setActionRecordId(null);
    }
  };

  const downloadSelected = async () => {
    if (!selected) return;
    setActionRecordId(selected.recordId);
    try {
      const bundle = await createDebugBundleFromArtifacts({ artifacts: selected.artifacts, reporterNote: "" });
      downloadDebugBundle(bundle);
      onToast("デバッグ用ZIPをダウンロードしました。", "success");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "ZIPを作成できませんでした。");
    } finally {
      setActionRecordId(null);
    }
  };

  const importFile = async (file: File | null | undefined) => {
    if (!file) return;
    setError(null);
    setImportMessage(null);
    if (!file.name.toLowerCase().endsWith(".zip") && file.type !== "application/zip" && file.type !== "application/x-zip-compressed") {
      setError("デバッグ用のZIPファイルを選択してください。");
      return;
    }

    setActionRecordId("import");
    try {
      const artifacts = await importDebugBundle(file);
      const record = createDebugHistoryRecord(artifacts);
      audioRef.current?.pause();
      setSelected(record);
      setImportedPreviewRecordId(record.recordId);
      setBrowseMode("drawings");
      setImportMessage("ZIPを読み込みました。まだこのブラウザには保存していません。");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "ZIPを読み込めませんでした。");
    } finally {
      setActionRecordId(null);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const saveImportedPreview = async () => {
    if (!selected || selected.recordId !== importedPreviewRecordId) return;
    const replacing = records.some((record) => record.recordId === selected.recordId);
    if (replacing && !window.confirm("同じ記録IDの履歴があります。読み込んだZIPの内容で上書きしますか？")) return;

    setActionRecordId("save-import");
    setError(null);
    try {
      await saveDebugHistoryRecord(selected.artifacts);
      await refresh();
      setImportedPreviewRecordId(null);
      setImportMessage(replacing ? "既存の履歴をZIPの内容で更新しました。" : "読み込んだZIPをこのブラウザの履歴へ保存しました。");
      onToast(replacing ? "デバッグ履歴を更新しました。" : "デバッグ履歴へ保存しました。", "success");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "履歴へ保存できませんでした。");
    } finally {
      setActionRecordId(null);
    }
  };

  const closeImportedPreview = () => {
    audioRef.current?.pause();
    setSelected(null);
    setImportedPreviewRecordId(null);
    setImportMessage(null);
  };

  const isImportedPreview = selected?.recordId === importedPreviewRecordId;

  const drawingData = useMemo<DrawingData | null>(() => {
    if (!selected) return null;
    return {
      imageUri: imageUrl ?? "",
      strokes: selected.manifest.drawing.strokes,
      strokeGroups: selected.manifest.drawing.strokeGroups,
      canvasSize: selected.manifest.drawing.canvasSize ?? undefined,
      lineWidth: selected.manifest.drawing.lineWidth ?? undefined,
    };
  }, [imageUrl, selected]);

  return (
    <main className="mb-16 w-full max-w-6xl">
      <section className="rounded-3xl border-8 border-violet-100 bg-white p-5 shadow-xl md:p-7">
        <div className="mb-5 flex flex-col gap-4 border-b-2 border-violet-50 pb-5 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.2em] text-violet-500">Browser-only</p>
            <h2 className="mt-1 text-2xl font-black text-gray-800">デバッグ履歴</h2>
            <p className="mt-2 max-w-2xl text-sm font-semibold leading-relaxed text-gray-500">
              このブラウザだけに保存された生成の記録です。ほかの人へ渡すときは、記録を開いてZIPを保存してください。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="flex rounded-full bg-violet-50 p-1">
              <button type="button" onClick={() => setBrowseMode("drawings")} aria-pressed={browseMode === "drawings"} className={`rounded-full px-4 py-2 text-sm font-black transition-all ${browseMode === "drawings" ? "bg-white text-violet-700 shadow-sm" : "text-gray-500"}`}>絵の一覧</button>
              <button type="button" onClick={() => setBrowseMode("songs")} aria-pressed={browseMode === "songs"} className={`rounded-full px-4 py-2 text-sm font-black transition-all ${browseMode === "songs" ? "bg-white text-violet-700 shadow-sm" : "text-gray-500"}`}>歌の一覧</button>
            </div>
            <button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-full border border-violet-100 bg-white px-4 py-2 text-sm font-black text-gray-600 shadow-sm transition hover:bg-violet-50 disabled:opacity-60">更新</button>
            <button type="button" onClick={onBack} className="rounded-full bg-violet-600 px-4 py-2 text-sm font-black text-white shadow-sm transition hover:bg-violet-700">メーカーへ戻る</button>
          </div>
        </div>

        <input
          ref={importInputRef}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          className="sr-only"
          onChange={(event) => void importFile(event.target.files?.[0])}
        />
        <section
          className="mb-5 rounded-2xl border-2 border-dashed border-violet-200 bg-violet-50/60 p-4"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void importFile(event.dataTransfer.files?.[0]);
          }}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-black text-violet-900">デバッグ用ZIPを確認する</p>
              <p className="mt-1 text-xs font-semibold leading-relaxed text-violet-700">ZIPを選ぶか、ここへドロップすると通信せずに内容をプレビューできます。保存はあとから選べます。</p>
            </div>
            <button type="button" onClick={() => importInputRef.current?.click()} disabled={actionRecordId === "import"} className="shrink-0 rounded-full bg-violet-600 px-4 py-2 text-xs font-black text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-60">
              {actionRecordId === "import" ? "読み込み中…" : "ZIPを選ぶ"}
            </button>
          </div>
        </section>
        <p className="sr-only" aria-live="polite">{importMessage ?? ""}</p>

        <p className="mb-5 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm font-semibold leading-relaxed text-violet-900">
          保存するかは、歌ができるたびに確認します。
        </p>

        {stats && (
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl bg-violet-50 p-3 text-center"><p className="text-xs font-black text-violet-500">保存件数</p><p className="mt-1 text-xl font-black text-gray-800">{stats.count} / 50</p></div>
            <div className="rounded-2xl bg-violet-50 p-3 text-center"><p className="text-xs font-black text-violet-500">履歴の容量</p><p className="mt-1 text-xl font-black text-gray-800">{formatBytes(stats.storedBytes)} / 100 MB</p></div>
            <div className="rounded-2xl bg-violet-50 p-3 text-center"><p className="text-xs font-black text-violet-500">ブラウザ全体</p><p className="mt-1 text-sm font-black text-gray-800">{stats.originUsageBytes !== null && stats.originQuotaBytes !== null ? `${formatBytes(stats.originUsageBytes)} / ${formatBytes(stats.originQuotaBytes)}` : "利用できません"}</p></div>
          </div>
        )}

        {error && <p className="mb-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700" role="alert">{error}</p>}
        {importMessage && <p className="mb-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800" aria-live="polite">{importMessage}</p>}

        {loading ? <p className="py-10 text-center font-bold text-gray-500">履歴を読み込んでいます…</p> : records.length === 0 ? (
          <div className="rounded-3xl border-2 border-dashed border-violet-100 bg-violet-50/50 px-5 py-12 text-center">
            <p className="text-lg font-black text-gray-700">まだデバッグ履歴はありません</p>
            <p className="mt-2 text-sm font-semibold text-gray-500">メーカーで生成するか、上のZIPを読み込むと内容を確認できます。</p>
          </div>
        ) : (
          <>
            {browseMode === "drawings" ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">{records.map((record) => (
              <div key={record.recordId} className="relative">
                <button type="button" onClick={() => void selectRecord(record.recordId)} disabled={loadingRecordId !== null || actionRecordId === record.recordId} className={`group h-full w-full overflow-hidden rounded-2xl border-2 bg-violet-50 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-md disabled:opacity-60 ${selected?.recordId === record.recordId && !isImportedPreview ? "border-violet-400 ring-2 ring-violet-200" : "border-violet-100"}`}>
                  <div className="relative aspect-square bg-white">{thumbnailUrls[record.recordId] ? <img src={thumbnailUrls[record.recordId]} alt={record.title} className="h-full w-full object-contain" /> : <div className="flex h-full items-center justify-center text-xs font-bold text-violet-300">絵を読み込み中…</div>}<span className={`absolute bottom-2 left-2 rounded-full px-2 py-1 text-[10px] font-black shadow-sm ${outcomeClass(record.manifest.outcome.status)}`}>{outcomeLabel(record.manifest.outcome.status)}</span></div>
                  <div className="p-3"><p className="truncate text-sm font-black text-gray-800">{record.title}</p><div className="mt-1 flex items-center justify-between gap-2"><p className="min-w-0 truncate text-xs font-bold text-violet-600">{record.identifiedObject}</p>{record.hasVoice && <span className="shrink-0 text-[10px] font-black text-gray-400">音声</span>}</div><p className="mt-2 text-[10px] font-bold text-gray-400">{new Date(record.createdAt).toLocaleString("ja-JP")}</p>{loadingRecordId === record.recordId && <p className="mt-2 text-xs font-black text-violet-600">読み込み中…</p>}</div>
                </button>
                <button type="button" onClick={(event) => { event.stopPropagation(); void deleteRecord(record.recordId); }} disabled={actionRecordId === record.recordId} className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full border border-white/80 bg-white/95 text-gray-500 shadow-sm transition-all hover:bg-red-50 hover:text-red-500 active:scale-95 disabled:opacity-60" title="削除" aria-label={`${record.title}を削除`}><svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
              </div>
            ))}</div> : <div className="divide-y divide-violet-50 overflow-hidden rounded-2xl border-2 border-violet-100">{records.map((record) => (
              <div key={record.recordId} className={`flex w-full items-stretch gap-2 px-4 py-3 transition-all hover:bg-violet-50 ${selected?.recordId === record.recordId && !isImportedPreview ? "bg-violet-50" : "bg-white"}`}><button type="button" onClick={() => void selectRecord(record.recordId)} disabled={loadingRecordId !== null || actionRecordId === record.recordId} className="min-w-0 flex-1 text-left disabled:opacity-60"><div className="flex items-center gap-2"><span className="min-w-0 truncate text-base font-black text-gray-800">{record.title}</span><span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black ${outcomeClass(record.manifest.outcome.status)}`}>{outcomeLabel(record.manifest.outcome.status)}</span>{record.hasVoice && <span className="shrink-0 text-[10px] font-bold text-gray-400">音声あり</span>}</div><span className="mt-1 block text-xs font-bold text-gray-400">{loadingRecordId === record.recordId ? "読み込み中…" : `${record.identifiedObject} ・ ${new Date(record.createdAt).toLocaleString("ja-JP")} ・ ${formatBytes(record.byteSize)}`}</span></button><button type="button" onClick={() => void deleteRecord(record.recordId)} disabled={actionRecordId === record.recordId} className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-full border border-white/80 bg-white text-gray-500 shadow-sm transition-all hover:bg-red-50 hover:text-red-500 active:scale-95 disabled:opacity-60" title="削除" aria-label={`${record.title}を削除`}><svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg></button></div>
            ))}</div>}
            <button type="button" onClick={() => void clearRecords()} disabled={actionRecordId === "all"} className="mt-4 w-full rounded-full border border-red-100 bg-white px-4 py-2 text-xs font-black text-red-500 transition hover:bg-red-50 disabled:opacity-60">すべて削除</button>
          </>
        )}

        <aside className="mt-6 min-w-0 rounded-3xl border-2 border-violet-100 bg-violet-50/40 p-4 sm:p-5">
          {!selected ? <p className="py-12 text-center text-sm font-bold text-gray-500">履歴または読み込んだZIPを選ぶと、内容の確認・再生・ZIP保存ができます。</p> : (
            <>
              {isImportedPreview && <p className="mb-4 rounded-xl border border-violet-200 bg-violet-100 px-3 py-2 text-xs font-black text-violet-800">読み込んだZIPをオフラインでプレビューしています。まだこのブラウザには保存していません。</p>}
              <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-black text-violet-500">{new Date(selected.createdAt).toLocaleString("ja-JP")}</p><h3 className="mt-1 text-xl font-black text-gray-800">{selected.title}</h3><p className="mt-1 text-sm font-bold text-gray-500">{selected.identifiedObject}</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => void downloadSelected()} disabled={actionRecordId === selected.recordId} className="rounded-full bg-violet-600 px-4 py-2 text-xs font-black text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-60">ZIPを保存</button>{isImportedPreview ? <><button type="button" onClick={() => void saveImportedPreview()} disabled={actionRecordId === "save-import"} className="rounded-full bg-emerald-600 px-4 py-2 text-xs font-black text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-60">{actionRecordId === "save-import" ? "保存中…" : "このブラウザに保存"}</button><button type="button" onClick={closeImportedPreview} className="rounded-full border border-violet-200 bg-white px-3 py-2 text-xs font-black text-violet-700">閉じる</button></> : <button type="button" onClick={() => void deleteRecord(selected.recordId)} disabled={actionRecordId === selected.recordId} className="rounded-full border border-red-100 bg-white px-3 py-2 text-xs font-black text-red-500 disabled:opacity-60">削除</button>}</div></div>
              {selected.manifest.outcome.error && <p className="mt-4 rounded-xl border border-red-100 bg-red-50 p-3 text-xs font-bold leading-relaxed text-red-700">失敗段階: {selected.manifest.outcome.failedStage ?? "不明"}<br />{selected.manifest.outcome.error}</p>}
              {selected.manifest.generation.voicevoxIssue && <p className="mt-3 rounded-xl border border-amber-100 bg-amber-50 p-3 text-xs font-bold leading-relaxed text-amber-800">VOICEVOX: {selected.manifest.generation.voicevoxIssue}</p>}
              {imageUrl && <img src={imageUrl} alt="保存した入力画像" className="mt-5 aspect-square w-full rounded-2xl border border-violet-100 bg-white object-contain" />}
              {selected.manifest.lyrics && <div className="mt-5"><KaraokeLyricsPanel lyrics={selected.manifest.lyrics} audioRef={audioRef} singingScore={selected.manifest.singingScore} showKanaLines /></div>}
              {audioUrl && drawingData && <><audio ref={audioRef} src={audioUrl} controls className="mt-4 w-full" aria-label={selected.artifacts.voiceAudioBlob ? "保存した歌声の再生" : "絵描き歌アニメーションの再生"} /><div className="mt-4 aspect-square overflow-hidden rounded-2xl border border-violet-100"><DrawingPlaybackCanvas drawingData={drawingData} audioRef={audioRef} mode="animated" lineStrokeMappings={selected.manifest.lyrics?.lineStrokeMappings} singingScore={selected.manifest.singingScore} lyricLineCount={selected.manifest.lyrics?.lines.length ?? 0} /></div></>}
            </>
          )}
        </aside>
      </section>
    </main>
  );
};

export default DebugHistoryView;
