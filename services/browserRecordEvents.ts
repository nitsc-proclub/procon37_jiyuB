const CHANGE_EVENT = "ekaki-browser-records-changed";

export function notifyBrowserRecordsChanged() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(CHANGE_EVENT);
      channel.postMessage("changed");
      channel.close();
    } catch { /* Polling also refreshes galleries when cross-tab messages are unavailable. */ }
  }
}

export function subscribeBrowserRecordsChanged(refresh: () => void) {
  window.addEventListener(CHANGE_EVENT, refresh);
  let channel: BroadcastChannel | null = null;
  try { if (typeof BroadcastChannel !== "undefined") channel = new BroadcastChannel(CHANGE_EVENT); }
  catch { /* Use the gallery's periodic reconciliation instead. */ }
  if (channel) channel.onmessage = refresh;
  return () => {
    window.removeEventListener(CHANGE_EVENT, refresh);
    channel?.close();
  };
}
