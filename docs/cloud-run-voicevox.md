# Cloud Run VOICEVOX

`voicevox/Dockerfile` は、VOICEVOX Engine を Cloud Run で動かすための最小コンテナ定義です。アプリ本体は引き続きCloudflare Worker Static Assetsで公開します。

Cloudflare WorkerからCloud RunへのOIDC認証、入力制限、混雑時のQueue overflowを実装済みです。Cloud Runは1 vCPU、2 GiB、container concurrency 1、min 0、max 3、timeout 120秒、起動時CPUブースト有効です。Cloud Run用Queue consumerとDurable Objectの実行枠も最大3に揃え、1インスタンスが1件ずつ合成する構成です。呼び出しは専用サービスアカウントだけに許可されています。詳細は[実測記録](voicevox-cloud-run-capacity.md)を参照してください。

サービス設定は`latest`タグ表示ですが、2026-08-31にrevisionの`spec.containers[0].image`と`status.imageDigest`を確認し、Dockerfileの固定digestと一致しました。稼働イメージを揃えるための再デプロイは不要です。今後の更新時も、タグだけでなく解決済みdigestを確認します。

## デプロイ前の確認

1. Google Cloudプロジェクトに請求先アカウントをリンクする。
2. Cloud Run API と Artifact Registry API を有効にする。
3. Cloud Runのコンテナポートを `50021` に設定する。
4. 初期値は CPU 1、同時実行数 1、最大インスタンス数を小さく設定して、音声生成時間とメモリを実測する。
5. 初回検証で解決されたVOICEVOX Engine imageをDockerfileにdigest固定する。更新時は新しいdigestを単体検証してから差し替える。

## 公開・連携の境界

Cloud Runをブラウザから直接利用しない。ブラウザは同一オリジンのCloudflare Worker `/api/voicevox/*`を呼び、WorkerだけがサービスアカウントからOIDC tokenを作ってCloud Runへ接続する。Cloud Run URLとサービスアカウント情報はブラウザ設定へ置かない。

現在はVPCを通常系とし、異なる未完了世代が2件ある状態で登録された3番目の世代からCloud Run Queueへ固定する。A/Bは必ず同じbackendを使う。VPC Queueはconcurrency 1、Cloud Run Queueはconcurrency 3で、Cloud Run用DOも同じ3枠とする。公開status APIのCloud Run応答は設定確認のみで、`liveCheck:false`のときEngineを起動していない。

VOICEVOX Engineは `VV_DISABLE_MUTABLE_API=1` により、辞書・設定を変更するAPIを無効化する。VOICEVOXのクレジット表記と、実際に使う音声ライブラリごとの利用規約は公開前に確認する。
