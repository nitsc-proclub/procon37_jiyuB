# 資料案内

はじめて見る方は[作品紹介と公開デモ](../README.md)からご覧ください。

## 審査・体験

| 知りたいこと | 資料 |
| --- | --- |
| 描画・生成・再生の操作 | [操作ガイド](guide/manual.md) |
| 特徴とコードの対応、短いデモの進め方 | [審査説明と実装根拠](guide/judging-evidence.md) |
| 構成、処理の流れ、公開版と展示版の違い | [技術概要](guide/technical-overview.md) |
| 保存先・同期・進捗の詳細 | [公開・ローカルの保存と表示](guide/public-local-experience.md) |
| 生成設定と容量検査 | [公開生成の仕様](guide/public-generation-parity.md) |

## 開発・運用

- [開発環境の起動](development/getting-started.md)と[品質確認](development/code-quality.md)
- [展示・保守の案内](operations/README.md)
- 実装詳細：[絵描き歌生成](development/ekaki-uta-generation.md)／[描画同期](development/drawing-playback-sync.md)
- [保留事項](development/BACKLOG.md)と[今回の検証範囲](operations/verification-2026-10-09.md)

## 過去の資料

[履歴一覧と移動先](archive/README.md)に、進捗、完了済み計画、旧仕様、当時の計測を保管しています。過去の検証結果は現在の稼働状態を保証しません。

## 資料の管理方針

- `guide/`：作品を理解・操作するための現行資料。実装根拠と確認日を示し、公開版と展示版を区別します。
- `operations/`：起動、展示、保守、障害対応。確認結果には日付・環境・未確認範囲を残します。
- `development/`：現在使う開発手順、設計の説明、未解決事項。
- `archive/`：終了した計画、旧仕様、進捗と実測の履歴。本文の日付と出典を残し、現行の説明から区別します。有効な手順や課題は現行資料にも残します。
- `assets/`：公開を許可された説明画像。出典・ページ・加工内容を記録し、読みやすさを確認して圧縮します。私的資料や認証情報を含めません。

ファイルを動かしたらMarkdown・画像・実装リンクを修正し、旧パスを全体検索します。外部共有済みの旧URLが判明している場合は短い移転案内を残します。今回の移動対応は[履歴一覧](archive/README.md)に記録しました。

アプリ本体、設定、起動スクリプト、`AGENTS.md`の配置は維持します。`dist/index.html`と`dist/logo.png`は既存のGit管理対象、`dist/assets`は既存の除外対象です。Workers Buildsはビルドして`dist`を配信するため、生成物を一括削除・一括除外しません。今回`.gitignore`は変更していません。

検証出力・一時プレビューはOSの一時フォルダーを使い、コミットしません。展示データ・ZIP・`.local-resources/`は公開資料に混ぜず、新規生成物は用途と配布方法を確認してからGit管理の要否を決めます。コミット前に差分とステージ対象を確認してください。
