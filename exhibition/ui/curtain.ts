export type CurtainPhase = 'idle' | 'closing' | 'closed' | 'opening';
export const CURTAIN_TIMING = { closing: 650, closed: 600, opening: 800 };
export function waitForCue(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
/** Hold the closed curtain until audio is loaded; an interrupted opening must never start a song. */
export async function openStage(prepare: () => Promise<unknown>, phase: (value: CurtainPhase) => void, signal: AbortSignal, wait = waitForCue) {
  signal.throwIfAborted(); phase('closing');
  await Promise.all([prepare(), wait(CURTAIN_TIMING.closing, signal)]); signal.throwIfAborted();
  phase('closed'); await wait(CURTAIN_TIMING.closed, signal); signal.throwIfAborted();
  phase('opening'); await wait(CURTAIN_TIMING.opening, signal); signal.throwIfAborted();
  phase('idle');
}
