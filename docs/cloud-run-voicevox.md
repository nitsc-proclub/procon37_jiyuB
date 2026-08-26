# Cloud Run VOICEVOX（準備段階）

`voicevox/Dockerfile` は、VOICEVOX Engine を Cloud Run へ単体検証するための最小コンテナ定義です。アプリ本体は引き続きCloudflare Worker Static Assetsで公開します。

## デプロイ前の確認

1. Google Cloudプロジェクトに請求先アカウントをリンクする。
2. Cloud Run API と Artifact Registry API を有効にする。
3. Cloud Runのコンテナポートを `50021` に設定する。
4. 初期値は CPU 1、同時実行数 1、最大インスタンス数を小さく設定して、音声生成時間とメモリを実測する。
5. 初回検証で解決されたVOICEVOX Engine imageをDockerfileにdigest固定する。更新時は新しいdigestを単体検証してから差し替える。

## 公開・連携の境界

この段階ではCloud Runをブラウザから公開利用しない。Cloudflare Workerの `/api/voicevox/*` プロキシ、WorkerからCloud Runへの認証、入力サイズ・音声長・回数制限を実装してからアプリへ接続する。

VOICEVOX Engineは `VV_DISABLE_MUTABLE_API=1` により、辞書・設定を変更するAPIを無効化する。VOICEVOXのクレジット表記と、実際に使う音声ライブラリごとの利用規約は公開前に確認する。
