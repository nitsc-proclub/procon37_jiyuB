# VOICEVOX内部基盤

2026-08-31に作成した段階導入用の基盤。公開アプリのHTTP経路にはまだ接続していない。

## 配置済み

| 対象 | 名前・設定 |
| --- | --- |
| 内部Worker | `cho-ekaki-uta-voicevox-infrastructure` |
| version | `23c1d6ba-7176-4bd4-8b10-f23c144be322` |
| HTTP | workers.dev・preview URL無効、routeなし。default/named entrypointも404 |
| SQLite Durable Object | `VoicevoxBackendPool` / binding `VOICEVOX_BACKEND_POOL` |
| 通常Queue | `cho-ekaki-uta-voicevox-jobs`、VPC consumer concurrency 1、保持24時間 |
| overflow Queue | `cho-ekaki-uta-voicevox-cloud-run-jobs`、公開Worker consumer concurrency 1、保持24時間 |
| DLQ用Queue | `cho-ekaki-uta-voicevox-dlq`、保持24時間 |
| D1 | 本番・Previewとも`0004_voicevox_jobs.sql`まで適用済み |
| R2 | `cho-ekaki-uta-voicevox-audio`、APAC・Standard・非公開 |

両Queueはjob参照だけを送り、失敗時は共通DLQへ最大3回後に転送する。歌詞を含むscore payloadは短命D1、生成WAVは短命・非公開R2に置く。

内部Workerのnamed entrypointは`VoicevoxInfrastructureWorker`。将来のconsumerはService Bindingから`acquireBackendLease`・`releaseBackendLease`・`snapshotBackendPool`を呼ぶ。

DOは`voicevox-backend-pool:v1:vpc`と`voicevox-backend-pool:v1:cloud-run`に分ける。各上限は1、標準leaseは5分。SQLiteで取得を直列化し、generation/job/attempt/lease IDで再送と解放を照合する。lease期限は実Engineの停止保証ではないので、consumer側にもtimeoutとD1の条件付き完了更新が必要である。

## 検証・配置

Node.js 22.17以降を使用する。Wrangler・Miniflare・esbuildはpackage-lockで固定し、実SQLはNodeのSQLite、DOは実Miniflareで検証する。

```powershell
npm.cmd ci
npm.cmd run type-check
npm.cmd test
npm.cmd run deploy:voicevox-infrastructure:check
npm.cmd run deploy:voicevox-infrastructure
```

本体と内部Workerは別のtsconfig・Wrangler生成型で検査する。生成型はGit管理せず`type-check`開始時に再生成する。この内部Workerの配置だけでは公開アプリは更新されない。

配置後にはloopbackの一時probeからService Binding経由で実DOへ接続し、同時2件で取得成功1件・同一lease再送・release後0件を確認した。probeは停止・削除済みで、歌声合成やQueue送信は行っていない。

## R2の設定（完了）

2026-08-31、利用者の有効化後にAPIが正常応答することを確認し、承認済みのbucketを作成した（作成時刻04:33:33 UTC）。`bucket info`でAPAC・Standard・0 objects、`dev-url get`で公開無効、`domain list`でカスタムドメインなしを確認済み。

実行した設定コマンドは以下。設定済みなので、次回は再作成せず参照確認から始める。

```powershell
npx.cmd wrangler r2 bucket list
npx.cmd wrangler r2 bucket create cho-ekaki-uta-voicevox-audio --location apac
npx.cmd wrangler r2 bucket dev-url disable cho-ekaki-uta-voicevox-audio
npx.cmd wrangler r2 bucket lifecycle add cho-ekaki-uta-voicevox-audio delete-temporary-wav wav/ --expire-days 1
```

`lifecycle list`で`delete-temporary-wav`（prefix `wav/`、1日後expire）が有効であることを確認した。1日のlifecycleは削除の安全網であり、厳密な24時間以内の削除保証やアプリ側の短い論理期限・定期削除の代わりにはしない。R2 bindingは、今後実際に使うconsumerへ追加する。音声のアップロード・配信・削除の一連の経路はまだ未検証である。

## 次の実装順序

### 2026-09-01 公開接続

内部Worker version `fea57e6b-e632-450c-9fd7-3b5de659a3de` を公開し、Queue consumer、D1、VPC、一時R2、2分ごとの回収処理を接続した。公開アプリはA/BをQueueへ一括登録し、2件とも完了してから歌詞選択を表示する。実ブラウザで2件のVPC合成と音声取得を確認した。

VPC consumerとCloud Run consumerはいずれもbatch 1・concurrency 1である。異なる未完了generationが2件以上あるとき、新しいgenerationのA/BをまとめてCloud Runへ固定する。1人分のA/Bや最初の2世代はVPCを使う。backendはD1登録時に固定し、再送時も別経路へ切り替えない。

2026-09-01のoverflow公開versionは、内部Worker `23c1d6ba-7176-4bd4-8b10-f23c144be322`、公開Worker `5fcb628e-5c60-4984-805a-fa54d81c8768`。本番・Preview D1へ`0007_voicevox_group_backend.sql`を適用済みで、旧jobのNULL backendはVPCへbackfillした。Cloud Runはrevision `voicevox-engine-00003-jjj`、min 0・max 1・concurrency 1である。

### 2026-08-31の追加実装（実Workerへ接続済み）

- `src/voicevoxJobLifecycle.ts`: D1の条件付きclaim/完了/再試行/キャンセル、期限切れ回収、短命payload削除。lease IDとattemptで古い処理を拒否する。
- `migrations/0005_voicevox_job_dispatch.sql`: 再送用のdispatch leaseと送信時刻を追加する。既存の適用済み0004は変更しない。**ローカル適用済み。本番・Previewへの0005適用はまだ行っていない。**
- `src/voicevoxJobDispatcher.ts`: accepted/queuedを永続的な再送対象として読み、送信枠取得→Queue.send→送信済み記録を行う。曖昧な失敗は期限後に再送する。初期10件/回・逐次処理、再送判定5分、送信lease30秒。
- `src/voicevoxTemporaryAudio.ts`: `wav/`配下の試行別音声、一時保持の論理期限、非公開/no-store配信、サイズ上限、期限後削除。既存bucketの1日lifecycleと併用する。

これらの関数を追加しただけでは、Queue consumer・scheduled handler・公開job APIは動かない。新しいクラウド保存同意や長期保管も未接続。長期保管は[作品データ保存拡張メモ](../../docs/creation-archive-plan.md)に分けて定義し、同意済み画像・線・A/B音声を一時bucketへ無期限に残す構成にはしない。

次回の結線では、`claimVoicevoxJob`の`applied`だけが合成開始の権利を持つ。`duplicate`を合成開始と解釈しない。DO枠取得→D1 claim→VPC合成→R2 put→D1 fenced complete→DO解放の順序を守り、キャンセル/期限切れ/失敗時の解放と孤児削除も試験する。D1の期限切れpayload削除と、結果参照を含むjob/groupの削除は別工程である。

再試行は既定3回・登録時上限5回（初回を含む）。期限到達後はキャンセルより期限切れを優先し、`failed/job-expired`へ統一する。先に有効期限内にキャンセル済みの場合は変更しない。定期handlerへ結線するときは、D1/R2呼び出し回数が契約上限を超えないよう処理件数を絞る。大きいWAVの一時保存は最大32 MiBの有界バッファを使うため、同一consumer内では並列に蓄積しない。

検証記録（2026-08-31）: `npm test` 76/76、root/infraの型検査、フロントbuild、内部Worker dry-run、`git diff --check`を確認。D1は実SQLiteで原子性・古いlease・再送・期限/キャンセル順を検証し、R2はmock障害試験に加えてMiniflareの実bindingでput/get/deleteを確認した。0005のローカルmigrationも適用済みで残件なし。今回は実サーバーへの合成要求・本番deploy・遠隔DB変更は行っていない。これを公開経路全体の動作確認と読み替えない。

1. R2利用開始とbucket設定。**完了。**
2. D1の登録とQueue送信間の障害対策（outbox/reconciliation）、job statusのlease fencing、期限後cleanup。**関数層を実装。定期実行・実環境の結線は未完了。**
3. Queue consumerをVPC専用・batch 1から接続。DLQと再試行を設定し、重複配信を試験する。
4. capability付きjob/audio APIと短命WAV配信を実装。保存同意とは別の生成用一時保持を簡潔に説明する。
5. 公開status APIによる不要なCloud Run起動を防止したうえで、混雑時のCloud Runを限定導入。**完了。statusは設定確認のみで`liveCheck:false`。**
6. A/B一括登録・polling・キャンセルをfeature flagでブラウザへ接続。

Cloud Run初回のWorker総時間は約20.7秒、後続2回のEngine合成部分は約11.5〜12.3秒。2026-09-01の追加2回は全体約23.6秒と18.9秒だった。厳密なcold開始や後続のWorker総時間は未確定である。現状はmax 1/min 0を維持し、3番目の重複世代から自動振り分けを有効にした。次は実利用ログを見ながら閾値を変更し、maxを増やす場合は別途費用と負荷を確認する。

詳細: [計画](../../docs/voicevox-public-scaling-plan.md)、[Cloud Run実測](../../docs/voicevox-cloud-run-capacity.md)。

既存の開発依存には`npm audit`で4件（high 3・low 1）が報告される。VOICEVOX基盤とは別にVite/PostCSS等の更新が必要である。`npm audit --omit=dev`は0件だった。開発サーバーはloopbackで利用する。
