# ドキュメント

超えかき歌！の使い方、仕組み、開発・運用に必要な情報をまとめています。[作品紹介と公開版](../README.md)から体験できます。

## 作品と使い方

| 知りたいこと | 資料 |
| --- | --- |
| コンセプトと開発の背景 | [作品紹介](guide/overview.md) |
| 描画・生成・再生の操作 | [操作ガイド](guide/manual.md) |
| 処理の流れと公開版・展示版の違い | [技術概要](guide/technical-overview.md) |
| 保存先と画面の動作 | [保存と表示の仕様](guide/public-local-experience.md) |
| 歌詞と歌声の生成設定 | [公開生成の仕様](guide/public-generation-parity.md) |

## 開発と運用

開発を始める方は[環境の準備と起動](development/getting-started.md)をご覧ください。展示や保守には[運用案内](operations/README.md)を用意しています。

処理の詳細は[絵描き歌生成](development/ekaki-uta-generation.md)と[描画同期](development/drawing-playback-sync.md)で説明しています。変更時の検査は[品質確認](development/code-quality.md)、継続中の課題は[保留事項](development/BACKLOG.md)を参照してください。

## 資料の管理方針

| フォルダー | 内容 |
| --- | --- |
| `guide/` | 作品紹介、使い方、技術概要 |
| `operations/` | 起動、展示、保守、トラブル対応 |
| `development/` | 開発手順、現在の設計、未解決事項 |
| `archive/` | 過去の計画、旧仕様、進捗と実測の記録 |
| `assets/` | 説明用画像と出典 |

[過去の資料](archive/README.md)には、記録時点の日付や条件を残しています。現在の仕様や稼働状態は、現行資料と設定を確認してください。

画像には出典と加工内容を記録します。ファイルを移動したときは参照リンクも更新し、外部共有済みの旧URLには必要に応じて移転案内を残してください。

アプリ本体、設定、起動スクリプトはリポジトリルートに置きます。`dist/index.html`と`dist/logo.png`はGit管理対象、`dist/assets`は除外対象です。公開時はWorkers Buildsでビルドした`dist`を配信します。

検証用の一時ファイルや展示データはコミットしません。`.local-resources/`は非公開の参照資料です。公開する画像やデータとは分けて管理してください。
