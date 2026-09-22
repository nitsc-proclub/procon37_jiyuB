import React, { useEffect, useState } from "react";
import { appFeatures } from "../config/appConfig";
import { getUsageStats } from "../services/demoRecordService";
import { getBrowserUsageStats } from "../services/debugHistoryDb";
import type { UsageStats } from "../types";

export default function GenerationStats({ refreshKey = 0 }: { refreshKey?: number }) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    (appFeatures.demoRecords ? getUsageStats() : getBrowserUsageStats())
      .then(value => { if (active) { setStats(value); setError(false); } })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [refreshKey]);
  return <section className="mb-5 rounded-2xl border border-sky-100 bg-sky-50 p-4" aria-label="生成回数">
    <h3 className="font-black text-slate-800">生成回数</h3>
    {error ? <p className="text-sm text-red-700">集計を読み込めませんでした。更新をお試しください。</p> : !stats ? <p>集計を読み込み中...</p> : <>
      <div className="my-3 grid grid-cols-3 gap-2 text-center text-sm">
        {[["累計", stats.totalGenerations], ["記録あり", stats.recordedGenerations], ["記録なし", stats.unrecordedGenerations]].map(([label, value]) =>
          <div key={label} className="rounded-xl bg-white p-3"><p>{label}</p><p className="text-2xl font-black text-sky-700">{value}</p></div>)}
      </div>
      <p className="mb-3 text-xs text-slate-600">{appFeatures.demoRecords
        ? "このローカルサーバーで開始した生成の回数です。記録あり／なしは生成前の選択です。2026/7/10〜7/17の集計は実際より少ない可能性があります。"
        : "このブラウザで開始した生成の回数です。保存すると記録ありに移ります。導入前は残っている保存済み作品だけを集計し、過去の記録なし回数は含みません。"}失敗した生成も含みます。記録の削除やZIPの読み込みでは回数は変わりません。</p>
      <div className="max-h-64 overflow-auto"><table className="w-full text-right text-sm">
        <thead><tr><th className="text-left">日付（日本時間）</th><th>合計</th><th>記録あり</th><th>記録なし</th></tr></thead>
        <tbody>{stats.days.map(day => <tr key={day.date} className="border-t border-sky-100"><th className="py-2 text-left">{day.date}</th><td>{day.generationCount}</td><td>{day.recordedCount}</td><td>{day.unrecordedCount}</td></tr>)}</tbody>
      </table></div>
    </>}
  </section>;
}
