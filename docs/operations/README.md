# 展示・保守の案内

## 展示を始める

[開発環境の起動](../development/getting-started.md)で必要な環境を準備してください。Windowsでは[ローカルサーバー管理](local-server-manager.md)から起動・停止できます。

保存先と接続先を確認し、[ギャラリー運用](local-gallery.md)の手順で展示画面と入力機器を設定します。会場では音量とネット接続を確かめ、歌声と描画を再生してください。新規生成の検証にはAPI利用が伴います。

公開版とVite開発サーバーの保存先は異なります。[技術概要](../guide/technical-overview.md)と[保存の詳細](../guide/public-local-experience.md)を確認してください。

## 設定・トラブル対応

| 用途 | 資料 |
| --- | --- |
| 設定とよくある不具合 | [ローカル運用・トラブルシュート](operations.md) |
| 公開と自動デプロイ | [Cloudflare Workersの運用](cloudflare-deployment.md) |
| 遠隔での音声生成 | [Cloud Run音声経路](cloud-run-voicevox.md) |
| 待ち行列と実行枠の管理 | [音声ジョブ基盤](../../infra/voicevox/README.md) |

新規のクラウド長期保存・評価中央保存は設定上停止中です。旧評価保存の設定や操作履歴は[履歴資料](../archive/evaluation-storage-operations.md)に保管しています。再開は通常の起動手順に含めず、保存同意・対象データ・環境を再確認してください。

## 検証と未解決事項

継続中の課題は[保留事項](../development/BACKLOG.md)にまとめています。[過去の動作確認](../archive/CODEX_STATUS.md)には、確認した環境と時点を記録しています。展示前には、使用する端末で動作を確認してください。
