import React, { useEffect, useRef, useState } from "react";
import {
  DEBUG_HISTORY_MAX_BYTES,
  DEBUG_HISTORY_MAX_RECORDS,
  deleteDebugHistoryRecord,
  getDebugHistoryImage,
  getDebugHistoryRecord,
  getDebugHistoryStats,
  listDebugHistoryRecords,
  setDebugHistoryFavorite,
  type DebugHistoryRecord,
  type DebugHistoryRecordSummary,
  type DebugHistoryStats,
} from "../services/debugHistoryDb";

interface Props {
  onOpenRecord: (record: DebugHistoryRecord) => void;
  onToast: (message: string, tone: "success" | "error") => void;
}

const UsageBar = ({ label, value, max, caption }: { label: string; value: number; max: number; caption: string }) => (
  <div className="min-w-0">
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <span className="text-xs font-bold text-gray-500">{label}</span>
      <span className="text-sm font-black tabular-nums text-gray-700">{caption}</span>
    </div>
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)} aria-valuetext={caption} className="h-2 overflow-hidden rounded-full bg-violet-100">
      <div className={`h-full rounded-full ${value / max >= 0.9 ? "bg-amber-400" : "bg-violet-400"}`} style={{ width: `${Math.min(100, Math.max(0, value / max * 100))}%` }} />
    </div>
  </div>
);

const PublicDemoRecordsView: React.FC<Props> = ({ onOpenRecord, onToast }) => {
  const [records, setRecords] = useState<DebugHistoryRecordSummary[]>([]);
  const [stats, setStats] = useState<DebugHistoryStats | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [browseMode, setBrowseMode] = useState<"drawings" | "songs">("drawings");
  const refreshSequence = useRef({ value: 0 });

  const refresh = async () => {
    const sequence = ++refreshSequence.current.value;
    setLoading(true);
    setError(null);
    try {
      const [nextRecords, nextStats] = await Promise.all([listDebugHistoryRecords(), getDebugHistoryStats()]);
      if (sequence !== refreshSequence.current.value) return;
      setRecords(nextRecords);
      setStats(nextStats);
    } catch (cause) {
      if (sequence === refreshSequence.current.value) setError(cause instanceof Error ? cause.message : "作品を読み込めませんでした。");
    } finally {
      if (sequence === refreshSequence.current.value) setLoading(false);
    }
  };

  useEffect(() => {
    const sequence = refreshSequence.current;
    void refresh();
    return () => { sequence.value++; };
  }, []);

  useEffect(() => {
    let disposed = false;
    const urls: string[] = [];
    void Promise.all(records.map(async record => {
      try {
        const blob = await getDebugHistoryImage(record.recordId);
        if (!blob || disposed) return null;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return [record.recordId, url] as const;
      } catch { return null; }
    })).then(entries => {
      if (!disposed) setThumbnails(Object.fromEntries(entries.filter(entry => entry !== null)));
    });
    return () => { disposed = true; urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [records]);

  const openRecord = async (recordId: string) => {
    setBusy(recordId);
    setError(null);
    try {
      const record = await getDebugHistoryRecord(recordId);
      if (record) onOpenRecord(record);
      else await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "作品を開けませんでした。");
    } finally { setBusy(null); }
  };

  const toggleFavorite = async (record: DebugHistoryRecordSummary) => {
    setBusy(record.recordId);
    setError(null);
    try {
      await setDebugHistoryFavorite(record.recordId, !record.isFavorite);
      await refresh();
    } catch { setError("お気に入りを変更できませんでした。"); }
    finally { setBusy(null); }
  };

  const deleteRecord = async (record: DebugHistoryRecordSummary) => {
    if (!window.confirm(`「${record.title}」を削除しますか？`)) return;
    setBusy(record.recordId);
    setError(null);
    try {
      await deleteDebugHistoryRecord(record.recordId);
      await refresh();
      onToast("作品を削除しました。", "success");
    } catch { setError("作品を削除できませんでした。"); }
    finally { setBusy(null); }
  };

  const favoriteButton = (record: DebugHistoryRecordSummary) => (
    <button type="button" onClick={() => void toggleFavorite(record)} disabled={busy !== null} aria-label={`${record.title}のお気に入り`} aria-pressed={record.isFavorite === true} className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-xl shadow-sm transition disabled:opacity-50 ${record.isFavorite ? "border-amber-200 bg-amber-50 text-amber-500" : "border-gray-100 bg-white/95 text-gray-400 hover:text-amber-500"}`}>
      {record.isFavorite ? "★" : "☆"}
    </button>
  );
  const deleteButton = (record: DebugHistoryRecordSummary) => (
    <button type="button" onClick={() => void deleteRecord(record)} disabled={busy !== null} aria-label={`${record.title}を削除`} title="削除" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gray-100 bg-white/95 text-gray-400 shadow-sm transition hover:bg-red-50 hover:text-red-500 disabled:opacity-50">
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  );
  const visibleRecords = favoriteOnly ? records.filter(record => record.isFavorite) : records;
  const thumbnail = (record: DebugHistoryRecordSummary) => thumbnails[record.recordId]
    ? <img src={thumbnails[record.recordId]} alt={record.title} className="h-full w-full object-contain" />
    : <span className="text-3xl text-violet-200" aria-hidden="true">♪</span>;

  return (
    <main className="mb-16 w-full max-w-6xl">
      <section className="rounded-3xl border-8 border-violet-100 bg-white p-4 shadow-xl md:p-7">
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <h2 className="shrink-0 text-2xl font-black text-gray-800">保存した作品</h2>
          <div className="flex flex-wrap items-center gap-2">
            <a href="/gallery" target="_blank" rel="noopener noreferrer" className="rounded-full border-2 border-yellow-300 bg-yellow-100 px-4 py-2 text-sm font-black text-orange-800 hover:bg-yellow-200">展示ギャラリーを開く</a>
            <button type="button" onClick={() => void refresh()} disabled={loading || busy !== null} className="rounded-full border border-violet-100 px-4 py-2 text-sm font-black text-gray-600 hover:bg-violet-50 disabled:opacity-50">更新</button>
            <button type="button" onClick={() => setFavoriteOnly(value => !value)} aria-pressed={favoriteOnly} className={`rounded-full border px-4 py-2 text-sm font-black transition ${favoriteOnly ? "border-amber-300 bg-amber-50 text-amber-700" : "border-violet-100 text-gray-600 hover:bg-violet-50"}`}>★ お気に入りのみ</button>
            <div className="flex rounded-full bg-violet-50 p-1">
              <button type="button" onClick={() => setBrowseMode("drawings")} aria-pressed={browseMode === "drawings"} className={`rounded-full px-4 py-2 text-sm font-black ${browseMode === "drawings" ? "bg-white text-violet-700 shadow-sm" : "text-gray-500"}`}>絵の一覧</button>
              <button type="button" onClick={() => setBrowseMode("songs")} aria-pressed={browseMode === "songs"} className={`rounded-full px-4 py-2 text-sm font-black ${browseMode === "songs" ? "bg-white text-violet-700 shadow-sm" : "text-gray-500"}`}>歌の一覧</button>
            </div>
          </div>
        </div>
        {stats && <div className="mb-6 grid gap-4 rounded-2xl bg-violet-50/50 px-4 py-3 sm:grid-cols-2 sm:gap-8">
          <UsageBar label="保存件数" value={stats.count} max={DEBUG_HISTORY_MAX_RECORDS} caption={`${stats.count} / ${DEBUG_HISTORY_MAX_RECORDS}`} />
          <UsageBar label="保存容量" value={stats.storedBytes} max={DEBUG_HISTORY_MAX_BYTES} caption={`${(stats.storedBytes / 1024 / 1024).toFixed(1)} / ${DEBUG_HISTORY_MAX_BYTES / 1024 / 1024} MB`} />
        </div>}
        {error && <p role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</p>}
        {loading ? <p role="status" className="py-12 text-center text-sm font-bold text-gray-400">読み込み中…</p> : visibleRecords.length === 0 ? (
          <p className="py-12 text-center text-sm font-bold text-gray-400">{favoriteOnly ? "お気に入りはありません" : "まだ保存した作品はありません"}</p>
        ) : browseMode === "drawings" ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {visibleRecords.map(record => <div key={record.recordId} className="relative">
              <button type="button" onClick={() => void openRecord(record.recordId)} disabled={busy !== null} aria-label={`${record.title}を開く`} className="h-full w-full overflow-hidden rounded-2xl border-2 border-violet-100 text-left transition hover:border-violet-300 hover:shadow-md disabled:opacity-50">
                <div className="flex aspect-square items-center justify-center bg-white p-2">{thumbnail(record)}</div>
                <p className="truncate bg-violet-50/60 px-3 py-3 text-sm font-black text-gray-800">{record.title}</p>
              </button>
              <div className="absolute left-2 top-2">{favoriteButton(record)}</div>
              <div className="absolute right-2 top-2">{deleteButton(record)}</div>
            </div>)}
          </div>
        ) : (
          <div className="divide-y divide-violet-100">
            {visibleRecords.map(record => <div key={record.recordId} className="flex items-center gap-2 py-3">
              <button type="button" onClick={() => void openRecord(record.recordId)} disabled={busy !== null} aria-label={`${record.title}を開く`} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left transition hover:bg-violet-50 disabled:opacity-50">
                <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-violet-100 bg-white">{thumbnail(record)}</span>
                <span className="truncate text-sm font-black text-gray-800">{record.title}</span>
              </button>
              {favoriteButton(record)}{deleteButton(record)}
            </div>)}
          </div>
        )}
      </section>
    </main>
  );
};

export default PublicDemoRecordsView;
