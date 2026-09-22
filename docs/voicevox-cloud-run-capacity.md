# VOICEVOX Cloud Run 容量実測

> 2026-09-22更新: 公開のCloud Run状態確認も実際の認証付き /version を呼ぶ。以下の「設定確認のみ」「liveCheck:false」の記述は旧仕様。現在の仕様は [公開・ローカルの保存と表示](public-local-experience.md)。
## 2026-08-31: 本番経路の少数確認

本番のCloudflare Workerだけを入口にして測定しました。リクエストで `cloud-run` を明示指定し、Workerの `X-Voicevox-Backend: cloud-run` を確認したため、WorkerのOIDCプロキシからCloud Runで合成する経路をまとめて検証できています。ブラウザからCloud Runへ直接アクセスする経路は、意図どおり存在しないため測定対象ではありません。

Cloud Runの設定は変更していません。`asia-northeast1` の `voicevox-engine` は、1 vCPU、2 GiB、concurrency 1、timeout 120秒、startup CPU boost有効、最小インスタンス数は未設定（Cloud Runの既定値0）、`maxScale: 1` です。トラフィックを受けるrevisionは `voicevox-engine-00001-tr5` でした。このrevisionの `spec.containers[0].image` と `status.imageDigest` は、`voicevox/Dockerfile` と同じ `mirror.gcr.io/voicevox/voicevox_engine@sha256:ab700b3768d0a2e9230d53e054b321f60409fda34fe794a333ae7202ab1c87f4` です。サービスのtemplateには人が指定した `:latest` タグが残りますが、revision作成時にこの不変digestへ解決されています。

### バージョン確認

2026-08-31 JSTに、Worker経由で `GET /api/voicevox/status?backend=cloud-run` を1回実行しました。

| リクエスト | HTTP | Workerの計測値 | curl全体 | Engine version |
| --- | --- | ---: | ---: | --- |
| 初回の状態確認 | 200 | 4,406 ms | 5,353 ms | 0.25.2 |

これは「初回リクエスト」と表現し、cold startとは断定しません。実行前のインスタンス数を示すCloud Runログは取得していないためです。

### 固定スコアの合成確認

同一の14.10秒スコアを使い、合成を3回だけ順に実行しました。すべてWorkerで `backend: "cloud-run"` を選択しました。初回はWorker境界までの結果を取得でき、後続2回はCloud Runのリクエストログで成功を確認できました。ローカル実行ホストが集計JSONを返す前に終了したため、後続2回のWorker全体時間は推測していません。

| リクエスト | Workerの結果 | Worker TTFB / 全体 | Cloud Run `sing_frame_audio_query` | Cloud Run `frame_synthesis` |
| --- | --- | --- | ---: | ---: |
| 初回合成 | HTTP 200、`cloud-run`、fallbackなし、有効なWAV 676,908 bytes | 20,246 / 20,690 ms | 6,849 ms | 12,194 ms |
| 続く合成 1 | Cloud Run HTTP 200 | 未取得 | 372 ms | 12,252 ms |
| 続く合成 2 | Cloud Run HTTP 200 | 未取得 | 312 ms | 11,476 ms |

後続2回で音声クエリ時間が短くなったことは、Engineプロセスが温まった状態と整合します。ただし初回がCloud Run cold startだった根拠にはなりません。この1 vCPU設定での `frame_synthesis` 自体は約11.5〜12.3秒でした。

### 再現用スクリプト

`scripts/measureVoicevoxCloudRun.mjs` は、`--run` と `--production` を両方指定しない限り実行しません。任意のホストは指定できず、対象は本番Workerに固定されています。既存remote D1へランダムな短命テストgrantだけを作成し、`backend: "cloud-run"` でWorkerに依頼します。seedの応答が不明な場合もcleanupを試み、cleanup失敗は主処理の結果と分けて出力します。スコアは14.10秒（28 notes）、SHA-256は `a7c8e9c2eb2786b615db7b80969193bae4885de6a52759f4ecbf30fcd0574902` です。

```powershell
node scripts/measureVoicevoxCloudRun.mjs --run --production --requests 1
```

1回の確認は最大3リクエストまでです。HTTP 200、`backend: "cloud-run"`、`fallback: "false"`、有効なWAVのすべてを満たさないリクエストが出た時点で、次の合成は送らずに停止します。各リクエストには180秒のtimeout、応答本文には8 MiBの上限を設けています。cold startを見積もる場合は、別日に十分なidle時間を置いて1回だけ実行し、実行前のインスタンス状態をログで確認してください。

## 2026-09-01: overflow公開前の追加確認

同じ固定スコアを本番Worker経由で1回ずつ確認した。どちらもHTTP 200、`cloud-run`、fallbackなし、有効な676,908 bytesのWAVで、試験用grantは削除済みである。

| 条件 | Worker TTFB | 全体 |
| --- | ---: | ---: |
| runtimeサービスアカウント変更前 | 23,558 ms | 23,623 ms |
| 専用runtimeサービスアカウントへ変更後 | 18,798 ms | 18,866 ms |

実行前のインスタンス状態を取得していないため、どちらもcold/warmとは断定しない。Cloud Runの実行identityは、project Editorだった既定Compute Engineサービスアカウントから、project roleを持たない`voicevox-runtime`専用サービスアカウントへ変更した。呼び出しidentityは従来どおりCloud Run Invokerだけを持つ`cf-voicevox-invoker`である。

overflow公開後の稼働revisionは`voicevox-engine-00003-jjj`。1 vCPU、2 GiB、concurrency 1、min 0、max 1、timeout 120秒を再確認した。設定更新中にmaxが20へ戻っていることを検出したため、公開確認中に1へ修正した。現在は最大1台であり、Cloud Run側の追加並列はまだ許可していない。

公開`/api/voicevox/status?backend=cloud-run`は、第三者の状態確認だけで課金対象インスタンスを起動しないよう、現在は設定確認だけを行う。`liveCheck:false`は「認証情報とURLの設定は有効だが、Engineへlive requestは送っていない」という意味である。実稼働確認はgrantで保護された合成要求とCloud Runログを使う。

## 2026-09-01: 最大3並列への変更

Cloud Runはcontainer concurrency 1とmin 0を維持し、service/revisionのmax instancesをともに3へ変更した。revision `voicevox-engine-00004-hmr`がReadyで100% trafficを受けている。同時にCloud Run用Queue consumerの`max_concurrency`とCloud Run用Durable Objectの`CLOUD_RUN_CAPACITY`も3に揃えた。これにより、1インスタンス1合成のまま最大3件を並列実行できる。さくらVPC経路は従来どおり1枠である。変更後は5・10世代の制御した負荷試験で、実際のスケールアウト数、待ち時間、エラーと再試行、Cloud Run利用量を確認する。
