import { useCallback, useEffect, useRef, useState } from "react";
import { listDemoRecords } from "../services/demoRecordService";
import type { DemoRecordSummary } from "../types";

export function useDemoRecords(active: boolean) {
  const [records, setRecords] = useState<DemoRecordSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const pending = useRef<Promise<void> | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback((showLoading: boolean) => {
    if (pending.current) return pending.current;
    if (showLoading) setLoading(true);
    setError(null);
    const request = (async () => {
      try {
        const next = await listDemoRecords();
        if (mounted.current) setRecords(next);
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : "デモ記録を読み込めませんでした。");
      } finally {
        pending.current = null;
        if (mounted.current) setLoading(false);
      }
    })();
    pending.current = request;
    return request;
  }, []);
  const reload = useCallback(() => load(true), [load]);
  const refresh = useCallback(() => load(false), [load]);
  const invalidate = useCallback(() => {
    const refreshAfterSave = () => { if (mounted.current) setRevision(value => value + 1); };
    // A save during an older request must still cause a fresh read afterward.
    if (pending.current) void pending.current.then(refreshAfterSave);
    else refreshAfterSave();
  }, []);
  // Empty results and failures are completed attempts. Retry only on entry,
  // explicit refresh, or a successful new save, not on loading-state changes.
  useEffect(() => { if (active) void reload(); }, [active, revision, reload]);
  return { records, setRecords, loading, error, setError, reload, refresh, invalidate };
}
