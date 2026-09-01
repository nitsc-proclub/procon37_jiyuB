# 公開版 VOICEVOX スケーリング実装メモ

作成日: 2026-08-30 (JST)

状態: **2026-08-31に承認取得後、Queue/DLQ用Queue作成・内部DO Worker配置・D1追加schema適用・Cloud Run実音声生成・R2非公開bucket作成まで確認。非同期経路の統合は未完了。公開アプリの生成経路は変更していない。**

## 1. このメモの目的

公開版で複数利用者の歌声生成が重なっても、さくらの高専未来サーバーを通常系として最大限使い、待ち時間が増えるときだけGoogle Cloud RunのVOICEVOXを追加する。

展示・体験会では、クラウド側の並列処理に依存せず、体験端末ごとにローカルVOICEVOXを用意する現在案を優先する。

このメモは次回作業の開始点である。2026-08-31までにCloudflare側の作業は承認済み、Cloud Runは無料枠を意識した限定検証・設定の承認済み。同じ作業の承認を繰り返し求めない。新しい恒常課金や公開範囲の拡大はその境界を明示する。

### 2026-08-31追記: 同意済み作品の保存拡張

評価だけでなく入力画像・描いた線・A/B歌詞/楽譜/音声も残す方針へ拡張する。大きい素材は専用の非公開R2、D1は索引・同意・評価に限定する。既存の「絵・歌声を送らない」という同意は流用せず、新同意以降の作品だけが対象。初期365日・容量予約/上限付きとし、生成用の一時R2とは分離する。容量試算と実装順序は[作品データ保存拡張メモ](creation-archive-plan.md)を参照。長期保存のAPI/UIはまだ有効にしていない。

## 2. 現在の実装で確認できたこと

### 公開版の経路

```text
ブラウザ
  → 同一オリジンのCloudflare Worker
  → Cloudflare VPC Service binding
  → Tunnel
  → さくらの高専未来サーバー上のVOICEVOX Engine

VPCが再試行可能な理由で失敗した場合
  → Worker
  → OIDC認証
  → Google Cloud Run上のVOICEVOX Engine
```

- ブラウザは `/api/voicevox/synthesize` に歌唱スコア、候補ごとの短命なワンタイムgrant、接続先指定を送る。
- `auto`を選んだブラウザは、利用できる場合は先にその端末のローカルVOICEVOXを試し、利用できない場合にWorkerのVPC→Cloud Run経路へ進む。
- WorkerはgrantをD1で1回だけ消費し、歌唱スコアを検証する。
- `auto`ではVPCを先に試し、再試行可能な失敗時にCloud Runへフォールバックする。
- WorkerはVOICEVOXの歌唱クエリ生成と音声合成を同期実行し、同じHTTP応答で`audio/wav`をストリームする。
- VPCの歌唱クエリは45秒、音声合成は120秒でタイムアウトする。
- 実行先は`X-Voicevox-Backend`、フォールバック有無は`X-Voicevox-Fallback`で返す。
- `wrangler.jsonc`にはVPC、Cloud Run URL、Cloud Run用サービスアカウントsecret、D1、Worker Logsがある。Queue、Durable Objects、R2のbindingはまだない。
- リポジトリのCloud Run用Dockerfileは公式CPUイメージをdigest固定し、`VV_CPU_NUM_THREADS=1`、変更系API無効である。2026-08-31に実revisionのdigestも同一と確認した。サービスの`latest`表示を稼働revision未固定と解釈した前回記述は訂正する。
- Cloud Runの現在設定とWorker経由の実音声生成は確認済みである。厳密なcold/warm比較とスケールアウト計測は[実測記録](voicevox-cloud-run-capacity.md)の限界を参照する。
- `docs/cloud-run-voicevox.md`にも現在の認証・設定と実測への参照を記録している。

関連箇所:

- [`src/worker.ts`](../src/worker.ts)
- [`wrangler.jsonc`](../wrangler.jsonc)
- [`services/voicevoxService.ts`](../services/voicevoxService.ts)
- [`services/voicevoxHttp.ts`](../services/voicevoxHttp.ts)
- [`voicevox/Dockerfile`](../voicevox/Dockerfile)
- [`docs/cloud-run-voicevox.md`](cloud-run-voicevox.md)
- [`docs/voicevox-vpc-capacity.md`](voicevox-vpc-capacity.md)

### 現在のA/B生成

Phase 1では、Geminiが歌詞候補A/Bと候補別のvoice grantを返す。ブラウザは2候補の楽譜と歌声を**1件ずつ順番に**準備し、両方が歌声または無音アニメーションのフォールバックになってから選択画面を表示する。

この方式にした理由は、VPC経由で同じ固定スコアを測った結果、2・3・5並列でも約8秒間隔で1件ずつ完了し、利用者から見て実質1並列だったためである。5件目は約40.4秒で、歌唱クエリの45秒制限に近い。

## 3. 提示案の評価

次の基本方針は妥当であり、維持する。

- さくらVOICEVOXは常時起動の通常処理担当とする。
- さくらへ流す合成は原則1件ずつとする。
- Cloudflare Queueで急増を吸収し、無制限にさくらへ到達させない。
- Cloud Runは混雑時の追加処理能力とし、通常時は`min instances = 0`を候補とする。
- Cloud Runはまず`concurrency = 1`とし、1インスタンスで原則1件を合成する。
- 同じ音声が再利用される可能性が低いため、再利用目的の音声キャッシュは実装しない。
- Cloud Runを使う条件は、単純なHTTPリクエスト数ではなく、現在の処理中・待機中の仕事量と予測待ち時間で決める。

ただし、現在案には実装前に補うべき重要な点がある。

### Queue導入時は同期WAV応答を維持しない

Cloudflare Queueは非同期処理用である。現在の`POST /api/voicevox/synthesize`の接続を開いたまま、Queue consumerが後から同じ応答へWAVを返す構成にはしない。

次回は次のジョブAPIへ段階移行する。

```text
ブラウザ
  → A/Bの2候補を1つの生成グループとして登録
  ← 202 Accepted + groupId/jobId

ブラウザ
  → 状態確認
  ← queued / running / succeeded / failed

完成後
  → 完成音声を取得
```

Queueを使う場合、完成WAVには非同期で受け渡す場所が必要になる。R2へ短期間だけ置く案を第一候補とする。これは同一音声を再利用する「キャッシュ」ではなく、完成ジョブをブラウザへ届けるための一時保管である。

またCloudflare Queueの1メッセージ上限は、現在のWorkerが許容するVOICEVOX要求上限より小さい。QueueメッセージへSingingScore全体を入れず、`jobId`、`generationId`、`candidateId`などの小さい参照だけを入れる。検証済みSingingScoreは短命なjob payloadとしてD1へ置き、consumerがjobIdで取得する案を第一候補とする。

一時音声をクラウドへ保存することになるため、保持時間、削除方法、利用者への簡潔な説明、既存の保存同意との境界を明示する。論理TTLは初期1時間（最大24時間以内）。通信再試行・A/B再生・同意後コピーのため取得直後には消さず、取得時の期限検証と期限切れジョブの定期削除を実装する。R2 lifecycleは最終的な安全網であり、厳密な短時間削除の保証には使わない。

## 4. 推奨構成

```text
                         ┌─ VPC ─ Tunnel ─ さくらVOICEVOX（実行枠1）
ブラウザ                 │
  → Worker API           │
  → 生成グループ登録     │
  → Cloudflare Queue ─ Consumer
             │           │
             │           └─ OIDC ─ Cloud Run VOICEVOX（0～N、各枠1）
             │
             ├─ Durable Object: backend別の実行枠・待機世代・leaseを調整
             ├─ D1: grant、ジョブの索引・状態・期限・冪等性
             └─ R2: 完成WAVの短期受け渡し
```

役割を分ける。

| 要素 | 役割 |
| --- | --- |
| Worker API | 同一オリジン確認、入力検証、grant引換、ジョブ作成、状態・音声取得 |
| Queue | 合成処理をHTTP要求から切り離し、急増吸収、再試行、DLQへの退避 |
| Durable Object | さくらの実行枠1を競合なく貸し出し、待機中の異なる生成世代を数え、接続先を決める |
| D1 | 公開grantと内部jobIdの対応、冪等性、期限、端末再接続に必要な最小状態 |
| R2 | 完成WAVの短期受け渡し。長期保存・再利用キャッシュにはしない |
| さくら | 常時起動の基本サーバー。原則1件ずつ処理 |
| Cloud Run | 混雑時またはVPC障害時の追加実行枠 |

Durable Objectはアプリ全体を1個へ集約せず、**調整対象のbackend poolごと**に置く。さくらは実体が1つなので1つの調整単位となる。DOの永続状態更新中にVOICEVOXへの長い外部通信は行わず、短いleaseの取得・更新・解放だけを直列化する。

Queueのbacklog metricは運用監視に使えるが、分散システム上の概算値である。候補A/Bを利用者数と区別した即時の振り分け判断には、DO/D1に登録した生成グループとleaseを正とする。

初期構成はQueue consumerのbatch sizeを1、最大consumer invocationを`さくら1 + Cloud Run最大3 = 4`とする候補から検証する。consumerはDOからbackend leaseを取得できたjobだけを実行し、まだ実行枠を与えないjobは短い遅延付きでretryする。Cloud Run最大数を変更するときはconsumer側の上限も合わせて見直す。

短いretryを繰り返すと再配信回数、遅延、Queue操作費用が増える。実測時はこれも計測し、必要ならDOが次の実行可能時刻を保持して再通知する方式と比較する。

## 5. A/Bを「1人分」として扱う方法

Queueのメッセージ1件を候補1曲とすると、1人だけでもA/Bで2件になる。したがって生のメッセージ数だけでCloud Runを起動してはいけない。

次回はGemini完了後に、A/Bを1つの**生成グループ**として一括登録する。

```text
generationId
  ├─ candidate-a job
  └─ candidate-b job
```

- スケジューリング上の混雑単位: 異なる`generationId`の数
- 実行単位: 候補ごとのjob
- 冪等性キー: `generationId:candidateId`
- 同一世代のA/Bは通常さくらへ順番に流す。
- 別世代が重なり予測完了時間が長くなるとき、後から来た世代または一部jobをCloud Runへ逃がす。
- Queueは順序を保証しないため、A/B順や同一世代の扱いはメッセージ到着順に依存させない。
- 同一世代のA/Bを異なるbackendへ分けてよいか、同じbackendへ固定するかは、Cloud Run実測後に完了時間と比較の公平性から決める。

これにより、1人が2曲を作っているだけではCloud Runを起動せず、別の利用者の生成世代が重なったときだけ追加能力を検討できる。

## 6. 初期スケジューリング案

固定値はまだ確定しない。最初の安全な候補は次のとおり。

```text
さくら
  active jobs = 最大1

異なる待機generation = 0～1
  → さくらのみ

異なる待機generation >= 2
  → Cloud Run利用候補

Cloud Run
  concurrency = 1
  min instances = 0
  max instances = 3から開始し、計測後に5まで検討
```

ただし最終判断は件数だけでなく、次の推定を使う。

```text
さくら予測完了時間
  ≒ 前にいるjob数 × 直近のさくらP75合成時間

Cloud Run予測完了時間
  ≒ coldまたはwarm起動見込み + 直近のCloud Run P75合成時間
```

Cloud Runの予測完了が一定の余裕をもって短い場合だけCloud Runへ送る。境界付近で振り分けが頻繁に変わらないよう、ヒステリシスまたは短いcooldownを入れる。

VPC障害時は混雑閾値と別にCloud Runへ切り替える。ただし無制限に再試行せず、最大試行回数、全体期限、DLQを設ける。

## 7. ジョブAPIのたたき台

これは契約案であり、まだ実装しない。

### 作成

`POST /api/voicevox/job-groups`

- `generationId`
- A/Bそれぞれの`candidateId`、voice grant、SingingScore
- 任意の接続先指定。公開版の`auto`はサーバー側スケジューラが最終決定する。

成功時は`202 Accepted`で、推測困難な`groupId`と候補別`jobId`を返す。

受付はA/Bを原子的に扱う。

- 各grantに保存済みの`generationId`・`candidateId`と、入力候補が一致することを検証する。
- A/B双方の検証、grant消費、job作成はD1 transactionまたは同等の仕組みで全成功・全失敗にする。
- 通信再送で同じ`generationId:candidateId`を受けた場合、grantを再消費せず既存jobを返す。
- A/B一括要求の全体上限、候補ごとの上限、短命D1 payloadの上限を別々に定める。

### 状態確認

`GET /api/voicevox/job-groups/:groupId`

候補ごとに次の状態を返す。

- `accepted`
- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`

UI向けにはbackend内部の詳細を直接見せず、「歌声を準備しているよ」「少しこんでいるよ」程度へまとめる。予測精度が確認できるまでは残り秒数を表示しない。

### 音声取得

`GET /api/voicevox/jobs/:jobId/audio`

- 完成前は`409`または`425`など、クライアント契約で決めた一定の応答を返す。
- 完成後は`audio/wav`をストリームする。
- 認可用の短命tokenまたは同一生成に結びつく署名を必要とする。
- 取得後の即時削除は再接続を壊すため、短い猶予を設けて期限削除する。

### 取消

`DELETE /api/voicevox/job-groups/:groupId`

取消はbest effortとする。待機中は実行しない。すでにVOICEVOXで実行中なら処理自体を止められない場合があるため、結果を破棄して期限削除する。

移行中は既存の`/api/voicevox/synthesize`をfeature flagの後ろに残し、問題時に同期方式へ戻せるようにする。

## 8. grant・冪等性・再試行

Cloudflare Queueはat-least-once deliveryであり、同じメッセージが複数回届く可能性がある。合成や状態更新を「1回だけ届く」前提にしない。

- 公開voice grantはジョブ受付時に1回だけ引き換える。
- Queue内部の再試行では公開grantを再利用しない。
- D1に`generationId:candidateId`の一意制約または同等の冪等性を設ける。
- consumerは開始前に既存の`succeeded/running/cancelled`を確認する。
- backend leaseには期限を持たせ、consumer停止後に永久占有されないようにする。
- leaseには単調増加するattemptまたはfencing tokenを持たせる。期限切れconsumerが遅れて完了しても、現在のleaseと一致しなければD1の成功状態やR2の正規result keyへ確定できないようにする。
- VOICEVOX呼び出し自体を途中停止できず孤児WAVが生じる場合に備え、jobId固定の条件付き結果保存と期限cleanupを行う。
- DOが決めたbackendはconsumerから`vpc`または`cloud-run`として強制指定する。`auto`のまま既存関数を呼び、Cloud Run予定jobが先にVPCへ入る状態にしない。
- VPC失敗後にCloud Runへ移す場合は、暗黙の同期fallbackではなく、lease解放と再スケジュールを伴う明示的な規則にする。
- 同じjobが再配信されても完成WAVと成功状態を二重作成しない。
- 再試行可能な通信失敗と、入力不正など再試行不能な失敗を分ける。
- 最大再試行後はDLQへ送り、ジョブを`failed`へ確定する。

現在のgrantは合成直前に消費されるため、Queue化ではこの境界の変更が必須である。

## 9. Cloud Runの検証項目

リポジトリにはCloud Run URLと認証経路があるが、実サービスの現在値を設定済みと決めつけない。次回は課金確認後、Cloud Consoleまたは`gcloud`で実値を取得する。

最初の候補:

- コンテナポート: `50021`
- concurrency: `1`
- min instances: `0`
- max instances: `3`
- CPU: まず現状確認。VOICEVOX起動・合成時間と費用を見て決める。
- memory: Engine起動時ピークと複数revision起動時を計測して決める。
- request timeout: cold start、モデル読込、歌唱クエリ、音声合成の合計より長くする。
- startup CPU boost: cold start短縮効果と費用を比較して検討する。
- 認証: ブラウザへ公開せず、既存のWorker OIDC経路を維持する。

必須計測:

1. `/version`のcold startとwarm応答
2. 固定スコア1件のcold/warm合成
3. concurrency 1で2・3・5件をCloud Runへ送り、インスタンス数と各完了時間を確認
4. CPU、メモリ、起動失敗、429/5xx、Worker/consumer全体時間
5. VPCとCloud Runを同時利用した2・3・5世代の完了時間
6. Cloud Run max instances到達時の待ち方と再試行

VOICEVOXコンテナはモデル読込が重い可能性があるため、`min instances = 0`が常に最適とは限らない。まず0で測定し、公開後の利用頻度とcold startが許容できない場合だけ、時間帯限定またはイベント時の`min = 1`を別案として費用比較する。

## 10. 観測する値

ログには歌詞、画像、音声、grantそのものを出さない。

- `jobId`
- `generationId`の不可逆な短い識別子
- `candidateId`
- enqueue、dispatch、開始、完了時刻
- queue wait、backend wait、query、synthesis、totalの各時間
- 選択backend、fallback理由
- retry回数、最終error code
- さくらactive job数
- 待機中の異なるgeneration数
- Cloud Run active job数と上限
- Queue backlog、最古メッセージ時刻、consumer concurrency
- R2一時音声の作成・取得・削除結果

現在の固定スコア実測と同じ条件を継続利用し、変更前後を比較できるようにする。

## 11. UI方針

- 展示用の明示的な`local`は、従来どおりブラウザから端末ごとのVOICEVOXへ直接接続し、Queue対象外とする。
- 公開標準の`auto`でローカルVOICEVOX探索を残すか、最初からremote job APIへ送るかは実装前に確定する。展示用ローカルと公開版クラウド処理はUI・API上で混同しない。
- A/B両方が歌声または無音フォールバックになるまで、現在と同じ1つの生成ローディングにまとめる。
- 通常表示は「2つの歌声を準備しているよ」。待ちが一定時間を超えた場合だけ「少しこんでいるよ」にする。
- Queue待機、さくら、Cloud Runなどのインフラ名は子ども向け画面へ出さない。
- タブ再読込で復帰する必要がある場合、短命なgroupIdを`sessionStorage`へ保存する案を検討する。長期履歴にはしない。
- 一方の候補だけ失敗しても、無音アニメーションへ切り替えてもう一方を待つ現在仕様を維持する。
- 両方が終端状態になってから歌詞選択と保存同意を表示し、選択後に追加のVOICEVOX待ちを発生させない。

## 12. 実装順序

### Phase 0: 事前監査・承認（完了）

1. Cloudflareプラン、Queues、Durable Objects、R2の利用可否と料金を確認する。
2. Google Cloudの課金、Cloud Run revision、サービスアカウント権限を確認する。
3. リソース作成・設定変更・実測で費用が発生し得ることを利用者へ示し、明示確認を得る。

#### 2026-08-30 読み取り監査結果

- Wrangler 4.126.0でCloudflareへOAuth認証済みである。現在のtokenは書き込み権限も持つため、以後の操作は対象とコマンドを限定する。
- Cloudflare Queueは0件、Durable Object namespaceは0件で、どちらもbinding未設定である。
- R2は未有効で、利用開始にはCloudflare Dashboardでsubscription checkoutが必要である。
- D1は本番とPreviewの2件があり、Workerは本番・stagingとも既存versionが稼働している。
- 現在のCloudflare契約がWorkers FreeかPaidかは、現在のtokenではsubscription情報を読めず未確認である。
- Queues、SQLite-backed Durable Objects、R2 StandardにはFree枠があるが、Free上限超過時の挙動やPaidの基本料金・超過料金が異なる。リソース作成前に契約と予算を確定する。
- Google Cloud SDK 582.0.0を絶対パスから利用できる。導入後のPATHは現在のCodexプロセスへ未反映だが、新しいターミナルでは解消する見込みである。既定projectは未設定なので、操作時はproject IDを明示する。
- 対象projectは`articulate-fort-478503-r5`、serviceは`voicevox-engine`、regionは`asia-northeast1`である。課金アカウントは接続済みで、serviceはReady、最新revisionへ100% trafficである。
- 現在設定は1 vCPU、2 GiB、concurrency 1、min 0、max 1、timeout 120秒、起動時CPUブースト有効、TCP 50021のstartup probeである。最大1インスタンスなので、現状はCloud Run側で複数jobを並列処理しない。
- ingressは`all`だが、Cloud Run Invokerは専用の`cf-voicevox-invoker`サービスアカウント1件だけに付与され、`allUsers`と`allAuthenticatedUsers`はない。Worker設定のCloud Run URLはserviceの有効URL一覧に含まれる。
- サービス設定のimageは`latest`表示だった。後続の2026-08-31監査で実revisionの解決済みimage digestはDockerfileと同一と確認したため、未固定という当初判断は訂正する。
- 読み取り監査ではQueue送信、リソース作成・変更・削除、SQL書き込み、secret変更、Cloud Run呼び出し、デプロイを行っていない。
- 現在の`GET /api/voicevox/status?backend=cloud-run`は、公開grantやrate limitなしでCloud Runの`/version`を呼ぶ。第三者によるcold startと負荷発生を防ぐため、Cloud Run自動利用より前にedge rate limitまたは短命capabilityを設計する。

以下は2026-08-30時点で残っていた承認事項である。2026-08-31に利用者はCloudflare作業をすべて承認し、Cloud Runも無料枠を意識した限定的な確認・設定を承認した。同じ承認を再度求めない。無料枠の残量はアカウント共有であり、ゼロ円を保証しない。

1. CloudflareのWorkers Free/Paid状態と、新規Queue・SQLite Durable Objectを作成してよいか。
2. R2 subscription checkoutを行い、Standard bucketを作成してよいか。
3. 現在すでに`min=0`、`concurrency=1`、`max=1`であるCloud Runへ、cold `/version` 1回と固定スコア合成1回を実行してよいか。
4. 試験時の予算上限と中止条件。

#### 2026-08-31 実施結果

- 限定Cloud Run実測は[実測記録](voicevox-cloud-run-capacity.md)に記載。最大1台・最小0台を維持し、version確認1回と固定スコア合成3回を実施。試験用grantは削除済み。
- `cho-ekaki-uta-voicevox-jobs`と`cho-ekaki-uta-voicevox-dlq`を保持24時間で作成。まだconsumerはなく、DLQ転送も未接続。
- `infra/voicevox/wrangler.jsonc`でHTTP非公開の内部WorkerとSQLite DOを配置。さくら・Cloud Runを各1枠に制限するRPCを実ランタイムで検証した。公開アプリとは未接続。
- 本番D1は0004、Preview D1は0003/0004を追加適用。既存評価データは変更していない。
- D1 repositoryは簡易mockから実SQLiteテストへ移行。同一msの既消費grant誤認、複数SELECTの不整合読取り、非同期処理中の入力変更を防いだ。
- R2は当初API 10042だったが、2026-08-31に利用者が有効化し、一覧APIの正常応答を確認した。`cho-ekaki-uta-voicevox-audio`をAPAC・Standardで作成し、r2.dev公開無効・カスタムドメインなし・`wav/`を1日後expireとするlifecycleを設定・再取得確認済み。現在0 objectsで、consumer bindingや音声受け渡しは未接続である。
- [内部基盤の手順](../infra/voicevox/README.md)に配置情報、R2設定コマンド、次の実装順序を記録した。

### Phase 1: 現状の再計測

1. さくら固定スコア計測を再実行する。
2. 可能なら同時刻のCPU、RAM、load average、VOICEVOXログを記録する。
3. Cloud Runのcold/warmを固定スコアで測る。
4. 計測から初期閾値とCloud Run max instancesを決める。

### Phase 2: ジョブ基盤を同期UIから切り離して実装

1. job group・job・leaseのスキーマと状態遷移をテストで確定する。**ローカル基盤まで完了。**
2. Workerの手書き`Env`をWrangler生成型へ寄せ、`fetch`・Durable Object classのbinding整合を型検査できるようにする。**完了。queue handlerは追加時に検査する。**
3. Queue、DLQ、R2、backend pool単位のDurable Objectを追加する。**Queue・DO・非公開R2 bucketは配置済み。consumerとR2 binding接続は未完了。**
4. grant引換と内部再試行を分離する。
5. consumerから既存のVPC/Cloud Run合成関数を再利用する。
6. 一時WAVの期限削除を実装する。
7. 構造化ログを追加する。

2026-08-31時点で、pure state machine、VOICEVOX backend adapter、D1 job repositoryと実SQLiteテスト、SQLite DOの実ランタイムテスト、D1 migration `0004_voicevox_jobs.sql`の本番/Preview適用、R2非公開bucketとlifecycle設定まで完了している。追加でD1 lifecycle/fencing・永続再送dispatcher・短命R2保存/取得/削除の関数層を実装した。`0005_voicevox_job_dispatch.sql`は本番/Preview未適用。Queue consumer、定期回収、公開job API、UI接続は未完了であり、公開前に実バックエンドを含む結線・障害試験が必要である。詳細は[内部基盤メモ](../infra/voicevox/README.md)を参照する。

### Phase 3: ブラウザをジョブAPIへ移行

1. A/Bを1つのjob groupで送る。
2. pollingから開始し、必要性が確認できた場合だけSSE/WebSocketを検討する。
3. 再読込、取消、片方失敗、新しい歌への切替を実装する。
4. feature flagで同期経路と切り替えられるようにする。

### Phase 4: 段階公開

1. Cloud Runへの自動振り分けを無効にした状態でQueue→さくらを確認する。
2. 管理用または試験用の強制Cloud Run経路で認証・cold/warm合成を確認する。
3. 小さいmax instancesと保守的な閾値で自動振り分けを有効にする。
4. 2・3・5世代の同時利用を試す。
5. 待ち時間、失敗率、費用を見て閾値を調整する。

## 13. 受入条件

- 1世代のA/Bだけなら、通常は2曲ともさくらで順次処理される。
- 異なる複数世代が重なったときだけ、決めた条件でCloud Runが使われる。
- さくらへ同時に2件以上の重い合成を流さない。
- Cloud Run 1インスタンスへ同時に複数合成を流さない。
- 同じQueueメッセージが再配信されても、二重合成・二重状態更新・grant再要求が起きない。
- タブを閉じてもサーバー側ジョブが不整合にならず、期限後に一時データが削除される。
- VPC障害、Cloud Run障害、Queue再試行、DLQ、R2失敗をそれぞれテストできる。
- A/B両方の準備完了後は、歌詞選択・保存同意・再生で追加合成を待たない。
- スマホ縦画面とPC横画面で同じ処理状態になり、文面は子ども向けに短い。
- ログへ歌詞、画像、WAV、grant、サービスアカウント情報を出さない。
- 旧同期経路へfeature flagで戻せる。

## 14. 次回の未確定事項

次回は実装前に次を確定する。

1. Cloud Runの実際のcold/warm時間、CPU、メモリ、現在のrevision設定
2. R2へWAVを一時保存することの利用者説明と保持時間
3. 初期Cloud Run起動条件を「異なる待機世代2件」にするか、予測時間を主条件にするか
4. Cloud Run `max instances`を3から始めるか
5. polling間隔、ジョブ全体期限、取消後の扱い
6. D1とDurable Object storageの責務分担と保存期間
7. SingingScoreを置く短命D1 job payloadの保持時間と削除方法
8. 公開標準`auto`でローカル探索を残すか、remote job APIを直接使うか
9. 同一generationのA/Bを同じbackendへ固定するか

Queue messageは小さいjob参照だけにする。実際のSingingScore JSONサイズ分布も測り、D1 job payloadの上限を現在の公開API入力上限より小さくできるか確認する。歌唱スコアには歌詞情報が含まれるため、D1に残す時間と削除確認を合わせて決める。

## 15. 参照資料

### プロジェクト内

- [`voicevox-vpc-capacity.md`](voicevox-vpc-capacity.md)
- [`cloud-run-voicevox.md`](cloud-run-voicevox.md)
- [`cloudflare-deployment.md`](cloudflare-deployment.md)

### 公式資料

- [Cloudflare Queues: How Queues Works](https://developers.cloudflare.com/queues/reference/how-queues-works/)
- [Cloudflare Queues: Delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Cloudflare Queues: Consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)
- [Cloudflare Queues: Batching, retries and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cloudflare Queues: Metrics](https://developers.cloudflare.com/queues/observability/metrics/)
- [Cloudflare Queues: Limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Cloudflare Queues: Pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- [Cloudflare Durable Objects: Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [Cloudflare R2: Pricing](https://developers.cloudflare.com/r2/pricing/)
- [Google Cloud Run configuration](https://cloud.google.com/run/docs/configuring)
- [Google Cloud Run minimum instances](https://cloud.google.com/run/docs/configuring/min-instances)
- [Google Cloud Run general development tips](https://cloud.google.com/run/docs/tips/general)
- [Google Cloud Run pricing](https://cloud.google.com/run/pricing)

## 16. 現時点の結論

第一候補は次の構成とする。

> A/Bを1つの生成グループとしてCloudflareへ登録し、Queueで急増と再試行を吸収する。さくらVOICEVOXは実行枠1の通常系とし、異なる生成世代の待機と予測完了時間が増えた場合だけ、concurrency 1・min 0・小さいmax instancesのCloud Runへ振り分ける。Durable Objectはbackend poolのlease調整、R2は完成WAVの短期受け渡しに限定する。

この構成なら、通常利用と1人分のA/Bではさくらを優先しながら、複数利用者の重なりだけCloud Runで緩和できる。またQueue化によって、現在の45秒付近の同期待機タイムアウトと、ブラウザ切断による処理中断の影響を小さくできる。

## 17. 2026-09-01 初期公開の到達点

- Cloudflare Queue、D1 job/outbox、Durable Object lease、短命非公開R2音声、capability付き登録・状態・音声・取消APIを公開経路へ接続した。
- Queue consumerは`max_batch_size=1`、`max_concurrency=1`。初期公開はさくらVPCだけを使い、A/Bを1件ずつ合成する。Cloud Runの自動振り分けはまだ無効である。
- 実ブラウザでは2ジョブとも`succeeded`となり、A/Bを準備してから選択画面を表示した。選択から保存同意画面への遷移は約0.38秒だった。
- 一時歌声は論理1時間・lifecycle 1日、歌唱score payloadは短命D1として定期削除する。重複配信、再試行、lease fencing、取消、期限切れをテストした。

次は複数世代の待ち時間とCloud Run cold/warm時間を同じjob経路で再測定し、世代数・予測待ち時間に基づくoverflowを追加する。単純なリクエスト件数だけでは起動しない。
