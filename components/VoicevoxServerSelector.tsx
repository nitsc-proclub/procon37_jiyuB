import React from "react";
import {
  VOICEVOX_SERVER_IDS,
  VOICEVOX_SERVER_LABELS,
  VoicevoxServerHealth,
  VoicevoxServerId,
} from "../services/voicevoxRouting";

type VoicevoxServerSelectorProps = {
  selectedServer: VoicevoxServerId;
  localBaseUrl: string;
  healthByServer: Partial<Record<VoicevoxServerId, VoicevoxServerHealth>>;
  onSelectServer: (server: VoicevoxServerId) => void;
  onLocalBaseUrlChange: (value: string) => void;
  onCheckServer: (server: VoicevoxServerId) => void;
  disabled?: boolean;
};

const getStatusLabel = (status: VoicevoxServerHealth["status"] | undefined) => {
  switch (status) {
    case "connected":
      return "接続済み";
    case "configured":
      return "設定確認済み";
    case "checking":
      return "確認中";
    case "unavailable":
      return "未接続";
    default:
      return "未確認";
  }
};

const getStatusClass = (status: VoicevoxServerHealth["status"] | undefined) => {
  switch (status) {
    case "connected":
      return "bg-emerald-500";
    case "checking":
      return "animate-pulse bg-orange-400";
    case "configured":
      return "bg-sky-400";
    case "unavailable":
      return "bg-amber-500";
    default:
      return "bg-gray-300";
  }
};

const VoicevoxServerSelector: React.FC<VoicevoxServerSelectorProps> = ({
  selectedServer,
  localBaseUrl,
  healthByServer,
  onSelectServer,
  onLocalBaseUrlChange,
  onCheckServer,
  disabled = false,
}) => {
  const selectedHealth = healthByServer[selectedServer];
  const isChecking = selectedHealth?.status === "checking";
  const isLocal = selectedServer === "local";

  return (
    <aside className="fixed right-4 top-4 z-[80] w-[min(20rem,calc(100vw-2rem))] text-left">
      <details className="max-h-[calc(100svh-2rem)] overflow-y-auto rounded-2xl border border-orange-200 bg-white/95 shadow-lg backdrop-blur-md">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-black text-gray-700 [&::-webkit-details-marker]:hidden">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${getStatusClass(selectedHealth?.status)}`} aria-hidden="true" />
          <span>歌声生成サーバー</span>
          <span className="ml-auto text-[11px] text-gray-500">{getStatusLabel(selectedHealth?.status)}</span>
          <span className="text-gray-400" aria-hidden="true">⌄</span>
        </summary>

        <div className="space-y-3 border-t border-orange-100 px-3 py-3 text-xs text-gray-600">
          <label className="block font-bold text-gray-700" htmlFor="voicevox-server-selection">
            使用するサーバー
            <select
              id="voicevox-server-selection"
              value={selectedServer}
              onChange={(event) => onSelectServer(event.target.value as VoicevoxServerId)}
              disabled={disabled || isChecking}
              className="mt-1 block min-h-10 w-full rounded-lg border border-orange-200 bg-white px-2.5 py-2 text-xs font-bold text-gray-700 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100 disabled:cursor-wait disabled:opacity-60"
            >
              {VOICEVOX_SERVER_IDS.map((server) => (
                <option key={server} value={server}>
                  {VOICEVOX_SERVER_LABELS[server]}
                </option>
              ))}
            </select>
          </label>

          <p className="leading-relaxed text-gray-500">
            自動では、ローカルVOICEVOXを確認してから、Cloudflare VPC、Google Cloud Runの順に切り替えます。
          </p>

          {isLocal && (
            <>
              <label className="block font-bold text-gray-700" htmlFor="voicevox-local-url">
                ローカルVOICEVOX URL
                <input
                  id="voicevox-local-url"
                  type="url"
                  value={localBaseUrl}
                  onChange={(event) => onLocalBaseUrlChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onCheckServer("local");
                    }
                  }}
                  disabled={disabled || isChecking}
                  spellCheck={false}
                  className="mt-1 block w-full rounded-lg border border-orange-200 bg-white px-2.5 py-2 font-mono text-[11px] text-gray-700 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100 disabled:cursor-wait disabled:opacity-60"
                  aria-describedby="voicevox-local-url-help"
                />
              </label>
              <p id="voicevox-local-url-help" className="leading-relaxed text-gray-500">
                例: <code className="font-mono">http://127.0.0.1:50021</code>（VOICEVOX Engineの50021番ポート）
              </p>
            </>
          )}

          <p className={`font-bold ${selectedHealth?.status === "connected" ? "text-emerald-700" : selectedHealth?.status === "unavailable" ? "text-amber-700" : "text-gray-600"}`} aria-live="polite">
            {selectedHealth?.message ?? (isLocal ? "このパソコンのVOICEVOXは、生成時にも確認します。" : "必要なときにボタンを押して疎通確認します。")}
            {selectedHealth?.version ? `（version ${selectedHealth.version}）` : ""}
          </p>

          <button
            type="button"
            onClick={() => onCheckServer(selectedServer)}
            disabled={disabled || isChecking}
            className="w-full rounded-full bg-orange-500 px-3 py-2 text-xs font-black text-white shadow-sm transition hover:bg-orange-600 disabled:cursor-wait disabled:opacity-60"
          >
            {isChecking ? "確認中..." : "バージョンを確認"}
          </button>

          <div className="rounded-xl bg-orange-50 p-2.5 leading-relaxed text-orange-900">
            <p className="font-black">デバッグ用の切り替え</p>
            <p className="mt-1">自動以外を選ぶと、そのサーバーだけを指定して歌声を生成します。確認ボタンでバージョンを問い合わせます。公開版のGoogle Cloud Runは設定のみを確認し、接続確認済みとは表示しません。</p>
          </div>
        </div>
      </details>
    </aside>
  );
};

export default VoicevoxServerSelector;
