import React, { useEffect, useRef, useState } from "react";
import {
  deleteCreationArchiveFromClient,
  downloadCreationArchiveDeletionReceipt,
  getCreationArchiveStatusFromClient,
  importCreationArchiveDeletionReceipt,
  listCreationArchiveEntries,
  type CreationArchiveIndexEntry,
} from "../services/creationArchiveService";

type Props = { open: boolean; onClose: () => void; onToast: (message: string, tone: "success" | "error") => void };

const CreationArchiveManager: React.FC<Props> = ({ open, onClose, onToast }) => {
  const [entries, setEntries] = useState<CreationArchiveIndexEntry[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const onToastRef = useRef(onToast);
  onCloseRef.current = onClose;
  onToastRef.current = onToast;
  const reload = () => setEntries(listCreationArchiveEntries());
  useEffect(() => { if (open) reload(); }, [open]);
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus(), 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyId) { onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!event.shiftKey && index === buttons.length - 1) { event.preventDefault(); buttons[0]?.focus(); }
    };
    document.addEventListener("keydown", onKey); return () => { window.clearTimeout(timer); document.removeEventListener("keydown", onKey); returnFocusRef.current?.focus(); };
  }, [open, busyId]);
  if (!open) return null;
  const remove = async (entry: CreationArchiveIndexEntry) => {
    if (!window.confirm("このクラウド保存を削除しますか？")) return;
    setBusyId(entry.archiveId);
    const result = await deleteCreationArchiveFromClient(entry.archiveId);
    setBusyId(null); reload();
    onToastRef.current(result.deleted ? "クラウド保存を削除しました" : result.error ?? "削除できませんでした", result.deleted ? "success" : "error");
  };
  const recover = async (entry: CreationArchiveIndexEntry) => {
    setBusyId(entry.archiveId);
    const result = await getCreationArchiveStatusFromClient(entry.archiveId);
    setBusyId(null); reload();
    onToastRef.current(result.error ?? (result.status === "complete" ? "保存は確認できました" : "保存はまだ完了していません"), result.error ? "error" : "success");
  };
  const importReceipt = async (file: File | undefined) => {
    if (!file) return;
    const result = await importCreationArchiveDeletionReceipt(file);
    reload(); onToastRef.current(result.error ?? "削除レシートを読み込みました", result.error ? "error" : "success");
  };
  const statusLabel: Record<CreationArchiveIndexEntry["status"], string> = { pending: "保存準備中", complete: "保存済み", partial: "一部未保存", deleting: "削除中", deleted: "削除済み", failed: "保存失敗" };
  return <div className="fixed inset-0 z-[97] flex items-center justify-center bg-slate-900/45 px-4" role="presentation">
    <section ref={dialogRef} className="max-h-[calc(100svh-2rem)] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="archive-manager-title">
      <h2 id="archive-manager-title" className="text-xl font-black text-gray-800">保存した作品</h2>
      <div className="mt-4 space-y-3">
        {entries.length === 0 && <p className="rounded-2xl bg-gray-50 p-4 text-sm font-bold text-gray-600">このブラウザに保存した作品はありません。</p>}
        {entries.map((entry) => <article key={entry.archiveId} className="rounded-2xl border border-sky-100 p-3">
          <p className="text-sm font-black text-gray-800">{new Date(entry.createdAt).toLocaleDateString("ja-JP")} の作品</p>
          <p className="mt-1 text-xs text-gray-500">状態: {statusLabel[entry.status]} ・期限: {new Date(entry.expiresAt).toLocaleDateString("ja-JP")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={busyId !== null} onClick={() => void recover(entry)} className="rounded-xl bg-sky-100 px-3 py-2 text-xs font-black text-sky-800">確認</button>
            <button type="button" onClick={() => downloadCreationArchiveDeletionReceipt(entry)} className="rounded-xl bg-gray-100 px-3 py-2 text-xs font-black text-gray-700">削除レシート</button>
            <button type="button" disabled={busyId !== null} onClick={() => void remove(entry)} className="rounded-xl bg-rose-100 px-3 py-2 text-xs font-black text-rose-800">削除</button>
          </div>
        </article>)}
      </div>
      <input ref={fileInputRef} type="file" accept="application/json,.json" className="sr-only" onChange={(event) => void importReceipt(event.target.files?.[0])} />
      <div className="mt-5 flex flex-wrap gap-2"><button type="button" onClick={() => fileInputRef.current?.click()} className="min-h-11 rounded-2xl bg-sky-100 px-4 py-2 text-sm font-black text-sky-800">削除レシートを読む</button><button type="button" onClick={onClose} className="min-h-11 rounded-2xl bg-gray-200 px-4 py-2 text-sm font-black text-gray-700">閉じる</button></div>
    </section>
  </div>;
};

export default CreationArchiveManager;
