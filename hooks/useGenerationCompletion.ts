import { useCallback, useEffect, useRef } from "react";

/** Finishing a job may wait for a visible animation, never for an absent view. */
export function useGenerationCompletion(visible: boolean) {
  const visibleRef = useRef(visible);
  const waiter = useRef<{ runKey: number; resolve: () => void } | null>(null);
  const cancel = useCallback(() => {
    const pending = waiter.current;
    waiter.current = null;
    pending?.resolve();
  }, []);
  const complete = useCallback((runKey: number) => {
    if (waiter.current?.runKey === runKey) cancel();
  }, [cancel]);
  const wait = useCallback((runKey: number) => {
    cancel();
    if (!visibleRef.current || document.hidden) return Promise.resolve();
    return new Promise<void>(resolve => { waiter.current = { runKey, resolve }; });
  }, [cancel]);

  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) cancel();
  }, [visible, cancel]);
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) cancel(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); cancel(); };
  }, [cancel]);
  return { wait, complete, cancel };
}
