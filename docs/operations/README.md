# 展示・保守の案内

## 展示を始める

1. [開発環境の起動](../development/getting-started.md)で必要な環境を準備する。
2. Windowsでは[ローカルサーバー管理](local-server-manager.md)の起動・停止手順を使う。
3. 保存先と接続先を確認し、[ギャラリー運用](local-gallery.md)で展示画面と入力機器を確認する。
4. 会場端末の音量、ネット接続、歌声、描画同期を実際に確認する。新規生成の検証はAPI利用を伴う。

公開版とVite開発サーバーの保存先は異なります。[技術概要](../guide/technical-overview.md)と[保存の詳細](../guide/public-local-experience.md)を確認してください。

## 設定・トラブル対応

- [ローカル運用・トラブルシュート](operations.md)
- [Cloudflare Workersの公開・自動デプロイ](cloudflare-deployment.md)
- [Cloud Run音声経路](cloud-run-voicevox.md)
- [音声ジョブ基盤](../../infra/voicevox/README.md)

新規のクラウド長期保存・評価中央保存は設定上停止中です。旧評価保存の設定や操作履歴は[履歴資料](../archive/evaluation-storage-operations.md)に保管しています。再開は通常の起動手順に含めず、保存同意・対象データ・環境を再確認してください。

## 検証と未解決事項

[今回の確認範囲](verification-2026-10-09.md)と[保留事項](../development/BACKLOG.md)を参照してください。過去の[状態記録](../archive/CODEX_STATUS.md)の成功例を、現在の端末や公開版の成功証明として扱わないでください。
