import { useEffect, useRef, useState } from "react";
import type { DemoRecordSummary } from "../types";
import { galleryRecords, GALLERY_SETTINGS } from "./model";

export function useGalleryRecords(onSnapshot: (records: DemoRecordSummary[], initial: boolean) => void) {
  const callback = useRef(onSnapshot);
  callback.current = onSnapshot;
  const refreshRef = useRef<() => void>(() => {});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false, inFlight = false, dirty = false, initialized = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (disposed) return;
      if (inFlight) { dirty = true; return; }
      inFlight = true;
      controller = new AbortController();
      try {
        const response = await fetch("/api/demo-records", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("作品を読み込めませんでした。接続を確認しています。");
        const data = await response.json() as { records: DemoRecordSummary[] };
        if (disposed) return;
        callback.current(galleryRecords(data.records), !initialized);
        initialized = true;
        setError(null);
      } catch (error) {
        if (!disposed) setError(error instanceof Error ? error.message : "作品を読み込めませんでした。");
      } finally {
        inFlight = false;
        if (!disposed) {
          setLoading(false);
          if (dirty) { dirty = false; void refresh(); }
        }
      }
    };
    refreshRef.current = () => { void refresh(); };
    const source = new EventSource("/api/demo-records/events");
    // ready is also sent after reconnect: recover anything missed while offline.
    source.addEventListener("ready", refreshRef.current);
    source.addEventListener("change", refreshRef.current);
    void refresh();
    const interval = window.setInterval(() => { if (!document.hidden) void refresh(); }, GALLERY_SETTINGS.reconcileEveryMs);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      disposed = true;
      controller?.abort();
      source.close();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      refreshRef.current = () => {};
    };
  }, []);
  return { loading, error, refresh: () => refreshRef.current() };
}
