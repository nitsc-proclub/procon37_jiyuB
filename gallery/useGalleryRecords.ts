import { useEffect, useRef, useState } from "react";
import type { DemoRecordSummary } from "../types";
import { galleryRecords, GALLERY_SETTINGS } from "./model";
import { loadGalleryRecords } from "./recordSource";
import { subscribeBrowserRecordsChanged } from "../services/browserRecordEvents";
import { appFeatures } from "../config/appConfig";

export function useGalleryRecords(onSnapshot: (records: DemoRecordSummary[], initial: boolean) => void) {
  const callback = useRef(onSnapshot);
  callback.current = onSnapshot;
  const refreshRef = useRef<() => void>(() => {});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false, inFlight = false, dirty = false, initialized = false;
    let releaseSnapshot = () => {};
    const refresh = async () => {
      if (disposed) return;
      if (inFlight) { dirty = true; return; }
      inFlight = true;
      try {
        const data = await loadGalleryRecords();
        if (disposed) { data.dispose(); return; }
        callback.current(galleryRecords(data.records), !initialized);
        releaseSnapshot();
        releaseSnapshot = data.dispose;
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
    const source = import.meta.env.DEV && appFeatures.demoRecords ? new EventSource("/api/demo-records/events") : null;
    // ready is also sent after reconnect: recover anything missed while offline.
    source?.addEventListener("ready", refreshRef.current);
    source?.addEventListener("change", refreshRef.current);
    const unsubscribe = appFeatures.debugHistory ? subscribeBrowserRecordsChanged(refreshRef.current) : () => {};
    void refresh();
    const interval = window.setInterval(() => { if (!document.hidden) void refresh(); }, GALLERY_SETTINGS.reconcileEveryMs);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      disposed = true;
      releaseSnapshot();
      source?.close();
      unsubscribe();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      refreshRef.current = () => {};
    };
  }, []);
  return { loading, error, refresh: () => refreshRef.current() };
}
