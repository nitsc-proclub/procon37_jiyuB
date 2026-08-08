import React, { useEffect, useMemo, useRef, useState } from "react";
import DrawingPlaybackCanvas from "./DrawingPlaybackCanvas";
import KaraokeLyricsPanel from "./KaraokeLyricsPanel";
import { createDebugBundleFromArtifacts, downloadDebugBundle } from "../services/debugBundleService";
import {
  clearDebugHistoryRecords,
  DebugHistoryRecord,
  DebugHistoryRecordSummary,
  DebugHistoryStats,
  deleteDebugHistoryRecord,
  getDebugHistoryRecord,
  getDebugHistoryStats,
  listDebugHistoryRecords,
} from "../services/debugHistoryDb";
import { createSilentPlaybackAudio } from "../services/silentPlaybackService";
import { DrawingData } from "../types";

interface DebugHistoryViewProps {
  autoSaveEnabled: boolean;
  onEnableAutoSave: () => void;
  onDisableAutoSave: () => void;
  onBack: () => void;
  onToast: (message: string, tone: "success" | "error") => void;
}

const formatBytes = (value: number) => {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

const outcomeLabel = (status: DebugHistoryRecordSummary["manifest"]["outcome"]["status"]) =>
  status === "success" ? "成功" : status === "partial" ? "一部完了" : "エラー";

const outcomeClass = (status: DebugHistoryRecordSummary["manifest"]["outcome"]["status"]) =>
  status === "success" ? "bg-emerald-100 text-emerald-700" : status === "partial" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700";

const DebugHistoryView: React.FC<DebugHistoryViewProps> = ({ autoSaveEnabled, onEnableAutoSave, onDisableAutoSave, onBack, onToast }) => {
  const [records, setRecords] = useState<DebugHistoryRecordSummary[]>([]);
  const [stats, setStats] = useState<DebugHistoryStats | null>(null);
  const [selected, setSelected] = useState<DebugHistoryRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingRecordId, setLoadingRecordId] = useState<string | null>(null);
  const [actionRecordId, setActionRecordId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

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

  const selectRecord = async (recordId: string) => {
    setLoadingRecordId(recordId);
    setError(null);
    try {
      const record = await getDebugHistoryRecord(recordId);
      if (!record) {
        setSelected(null);
        await refresh();
        return;
      }
      setSelected(record);
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
              このブラウザだけに保存された生成記録です。ほかの人へ渡すときは、記録を開いてZIPを保存してください。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-full border border-violet-100 bg-white px-4 py-2 text-sm font-black text-gray-600 shadow-sm transition hover:bg-violet-50 disabled:opacity-60">更新</button>
            <button type="button" onClick={onBack} className="rounded-full bg-violet-600 px-4 py-2 text-sm font-black text-white shadow-sm transition hover:bg-violet-700">メーカーへ戻る</button>
          </div>
        </div>

        {!autoSaveEnabled && (
          <div className="mb-5 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm font-semibold leading-relaxed text-violet-900">
            <p className="font-black">自動保存はオフです</p>
            <p className="mt-1">次回から成功・失敗した生成をこのブラウザに保存できます。画像、歌詞、楽譜、実歌声だけを保存し、APIキーや認証情報は保存しません。</p>
            <button type="button" onClick={onEnableAutoSave} className="mt-3 rounded-full bg-violet-600 px-4 py-2 text-xs font-black text-white shadow-sm transition hover:bg-violet-700">自動保存を有効にする</button>
          </div>
        )}
        {autoSaveEnabled && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">
            <p><span className="font-black">自動保存はオンです。</span> 次の生成からこのブラウザの履歴へ保存します。</p>
            <button type="button" onClick={onDisableAutoSave} className="rounded-full border border-emerald-200 bg-white px-4 py-2 text-xs font-black text-emerald-700 transition hover:bg-emerald-100">自動保存をオフにする</button>
          </div>
        )}

        {stats && (
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl bg-violet-50 p-3 text-center"><p className="text-xs font-black text-violet-500">保存件数</p><p className="mt-1 text-xl font-black text-gray-800">{stats.count} / 50</p></div>
            <div className="rounded-2xl bg-violet-50 p-3 text-center"><p className="text-xs font-black text-violet-500">履歴の容量</p><p className="mt-1 text-xl font-black text-gray-800">{formatBytes(stats.storedBytes)} / 100 MB</p></div>
            <div className="rounded-2xl bg-violet-50 p-3 text-center"><p className="text-xs font-black text-violet-500">ブラウザ全体</p><p className="mt-1 text-sm font-black text-gray-800">{stats.originUsageBytes !== null && stats.originQuotaBytes !== null ? `${formatBytes(stats.originUsageBytes)} / ${formatBytes(stats.originQuotaBytes)}` : "取得できません"}</p></div>
          </div>
        )}

        {error && <p className="mb-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700" role="alert">{error}</p>}

        {loading ? (
          <p className="py-10 text-center font-bold text-gray-500">履歴を読み込んでいます…</p>
        ) : records.length === 0 ? (
          <div className="rounded-3xl border-2 border-dashed border-violet-100 bg-violet-50/50 px-5 py-12 text-center">
            <p className="text-lg font-black text-gray-700">まだデバッグ履歴はありません</p>
            <p className="mt-2 text-sm font-semibold text-gray-500">メーカーで生成すると、許可した場合にここへ保存されます。</p>
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.2fr)]">
            <div className="space-y-2">
              {records.map((record) => (
                <article key={record.recordId} className={`rounded-2xl border p-3 transition ${selected?.recordId === record.recordId ? "border-violet-300 bg-violet-50" : "border-gray-100 bg-white"}`}>
                  <button type="button" onClick={() => void selectRecord(record.recordId)} className="w-full text-left" disabled={loadingRecordId === record.recordId}>
                    <div className="flex items-start justify-between gap-2"><strong className="line-clamp-1 text-sm text-gray-800">{record.title}</strong><span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-black ${outcomeClass(record.manifest.outcome.status)}`}>{outcomeLabel(record.manifest.outcome.status)}</span></div>
                    <p className="mt-1 text-xs font-bold text-gray-500">{new Date(record.createdAt).toLocaleString("ja-JP")}</p>
                    <p className="mt-1 text-xs font-semibold text-gray-400">{record.identifiedObject} ・ {formatBytes(record.byteSize)}{record.hasVoice ? " ・ 歌声あり" : ""}</p>
                  </button>
                  <button type="button" onClick={() => void deleteRecord(record.recordId)} disabled={actionRecordId === record.recordId} className="mt-2 text-xs font-black text-red-500 hover:text-red-700 disabled:opacity-60">削除</button>
                </article>
              ))}
              <button type="button" onClick={() => void clearRecords()} disabled={actionRecordId === "all"} className="w-full rounded-full border border-red-100 bg-white px-4 py-2 text-xs font-black text-red-500 transition hover:bg-red-50 disabled:opacity-60">すべて削除</button>
            </div>

            <aside className="min-w-0 rounded-3xl border-2 border-violet-100 bg-violet-50/40 p-4 sm:p-5">
              {!selected ? <p className="py-12 text-center text-sm font-bold text-gray-500">左の履歴を選ぶと、内容の確認・再生・ZIP保存ができます。</p> : (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div><p className="text-xs font-black text-violet-500">{new Date(selected.createdAt).toLocaleString("ja-JP")}</p><h3 className="mt-1 text-xl font-black text-gray-800">{selected.title}</h3><p className="mt-1 text-sm font-bold text-gray-500">{selected.identifiedObject}</p></div>
                    <div className="flex gap-2"><button type="button" onClick={() => void downloadSelected()} disabled={actionRecordId === selected.recordId} className="rounded-full bg-violet-600 px-4 py-2 text-xs font-black text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-60">ZIPを保存</button><button type="button" onClick={() => void deleteRecord(selected.recordId)} disabled={actionRecordId === selected.recordId} className="rounded-full border border-red-100 bg-white px-3 py-2 text-xs font-black text-red-500 disabled:opacity-60">削除</button></div>
                  </div>
                  {selected.manifest.outcome.error && <p className="mt-4 rounded-xl border border-red-100 bg-red-50 p-3 text-xs font-bold leading-relaxed text-red-700">失敗段階: {selected.manifest.outcome.failedStage ?? "不明"}<br />{selected.manifest.outcome.error}</p>}
                  {selected.manifest.generation.voicevoxIssue && <p className="mt-3 rounded-xl border border-amber-100 bg-amber-50 p-3 text-xs font-bold leading-relaxed text-amber-800">VOICEVOX: {selected.manifest.generation.voicevoxIssue}</p>}
                  {imageUrl && <img src={imageUrl} alt="保存した入力画像" className="mt-5 aspect-square w-full rounded-2xl border border-violet-100 bg-white object-contain" />}
                  {selected.manifest.lyrics && <div className="mt-5"><KaraokeLyricsPanel lyrics={selected.manifest.lyrics} audioRef={audioRef} singingScore={selected.manifest.singingScore} showKanaLines /></div>}
                  {audioUrl && drawingData && <><audio ref={audioRef} src={audioUrl} controls className="mt-4 w-full" aria-label={selected.artifacts.voiceAudioBlob ? "保存した歌声の再生" : "絵描き歌アニメーションの再生"} /><div className="mt-4 aspect-square overflow-hidden rounded-2xl border border-violet-100"><DrawingPlaybackCanvas drawingData={drawingData} audioRef={audioRef} mode="animated" lineStrokeMappings={selected.manifest.lyrics?.lineStrokeMappings} singingScore={selected.manifest.singingScore} lyricLineCount={selected.manifest.lyrics?.lines.length ?? 0} /></div></>}
                </>
              )}
            </aside>
          </div>
        )}
      </section>
    </main>
  );
};

export default DebugHistoryView;
