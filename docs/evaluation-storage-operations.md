# 評価データ保存の運用手順（Step 5）

この文書は、Step 5の評価データ中央保存をCloudflare Worker + D1で運用する手順である。staging検証完了後の2026-08-24に、本番の二段生成と中央保存を有効化した。

## 現在の設定状態（2026-08-24）

- 本番D1とPreview専用D1を作成済み。本番`wrangler.jsonc`の`EVALUATIONS_DB.database_id`は本番D1だけを指し、Preview D1は`wrangler.staging.jsonc`の`database_id`にだけ設定する。
- `0001_evaluation_records.sql`と`0002_evaluation_followups.sql`をローカル・Preview D1・本番D1へ適用済み。0002適用時は本番の既存評価11件を維持し、事後評価0件から開始した。
- `EVALUATION_RECEIPT_SECRET`をWorker Secretへ登録済み。値は端末・文書・Gitへ保存していない。
- Cloudflare Version Previewへ一時的に中央保存ONの版をアップロードし、同一Origin・`no-store`・payload検証・Secret認識を確認した。ただしVersion Previewは`preview_database_id`へ自動切替されず本番D1 bindingだった。送信は無効payloadだけで本番D1は0件のまま。公開aliasは中央保存OFFの安全な版へ差し替え済み。
- 本番ON前にはD1 bindingとSecretを含むOFF版をデプロイし、配信Versionの本番D1 UUID、トップページ200、評価APIの503 + `no-store`を確認した。
- 監査中に作成した中央保存ONの旧Version URLを無効化するため、`preview_urls=false`を設定済み。以後の保存確認は本番D1を参照しない別staging Workerで行う。
- `wrangler.staging.jsonc`で独立した`cho-ekaki-uta-staging` Workerを定義した。`database_id`をPreview D1へ直接向け、本番Worker・本番D1とは分離する。
- staging専用Turnstile Widgetの公開Site keyは`.env.staging`からbuildへ渡す。Widget Secret、Gemini API key、評価receipt secretはstaging Worker Secretにだけ登録し、Gitへ保存しない。
- 本番の公開Turnstile Site keyと実験ラウンドIDは`.env.production`でGit管理する。どちらもブラウザbundleへ入る非秘密値であり、Worker Secretをこのファイルへ書いてはいけない。手動のversion upload・deploy前には`npm.cmd run build`を実行する。Workers BuildsはBuild commandを`npm run build`、Deploy commandを`npx wrangler deploy`に固定し、`build:deployment-preview`や`--assets`を使わない。
- stagingの実ブラウザでTurnstile、二段生成、A/B第一印象選択、同意保存、同意拒否、390x844と1280x800の横はみ出しなしを確認済み。Preview D1には同意したテスト評価が1件あり、拒否後も1件のままである。
- 本番Version `ce95b03f-e723-4738-8115-afa59379682a`を100%配信し、`LYRICS_PIPELINE_MODE=phase1`、`EVALUATION_CENTRAL_STORAGE_ENABLED=true`、本番D1 UUID `c305d19d-2119-4eb4-8e82-f941e8f57414`、3 Secretを実測した。トップページ200、評価APIのpayload拒否400 + `no-store`を確認し、本番D1は有効化時点で0件である。
- Workers Buildsに残っていた旧`build:deployment-preview` / `--assets`設定がpush後に本番を上書きしたため、検証済みVersionへ即時復旧した。その後、Dashboardの本番Build commandを`npm run build`、Deploy commandを`npx wrangler deploy`へ修正し、Cloudflare APIから保存値を再確認した。
- 修正後のWorkers Buildsで、`wrangler deploy`が本番config内の`preview_database_id`を本番Workerへ結び付ける挙動を実測した。自動Versionは検証済みVersionへ即時rollbackし、本番configから`preview_database_id`を削除して、Preview D1を専用staging configへ完全分離した。
- 分離修正後のWorkers Build `34a5d878-740d-48fe-bf63-8bb64a2320dc`は成功した。配信Version `db3b7d7c-4b98-42c9-b0a4-1d02bea3c6f0`で本番D1 UUID、3 Secret、二段生成・中央保存ONを再確認し、トップページ200、同一Origin制約、payload拒否400 + `no-store`、本番D1 0件を確認した。以後のVersion IDはpushごとに変わるため、固定値ではなく`wrangler versions view`で配信Versionのbindingを確認する。

## 公開版・staging・ローカルの分離

| 用途 | Worker / URL | 設定 | D1 |
| --- | --- | --- | --- |
| 公開版 | `cho-ekaki-uta.nitsc-proclub.workers.dev` | `wrangler.jsonc` | `cho-ekaki-uta-evaluations` |
| 確認版 | `cho-ekaki-uta-staging.nitsc-proclub.workers.dev` | `wrangler.staging.jsonc` | `cho-ekaki-uta-evaluations-preview` |
| ローカル | Vite / Wranglerのローカル起動 | `.env.local`等のGit対象外設定 | WranglerローカルD1 |

stagingを出すときは`npm.cmd run deploy:staging`、設定とbundleだけ確認するときは`npm.cmd run deploy:staging:check`を使う。本番のdry-runは`npm.cmd run deploy:production:check`を使う。各スクリプトがbuildと対象configをまとめて指定するため、手入力で本番・stagingを混ぜない。

画面下部には`公開版` / `確認版` / `ローカル`と、Vite build時のGit commit先頭7文字を小さく表示する。表示値の全commitは要素のtitle属性で確認できる。配信中のbundleとGit履歴の対応確認にはこの表示を使い、Worker bindingとVersion IDは`wrangler versions view`で別に確認する。

## 保存境界

中央保存するのは、利用者が毎回同意した最小限の評価メタデータだけとする。

- 保存対象: `generationId`、表示順、候補歌詞、最初の印象の選択、`DrawingAnalysis`、stroke group IDの参照、モデル名・版、同意状態、保存日時。任意の事後送信では、聞き比べ後の最終選択、3.7題材候補への固定回答、4項目の固定3段階評価
- 保存しない: 完成画像、音声、raw strokes、氏名、年齢、生年月日、自由記述、Cloudflare Access情報、APIキー
- ローカル起動: IndexedDBの端末内下書きだけを使い、中央へ送信しない
- 公開版: 同意ポップアップで拒否しても、生成・再生は継続できる
- 既存のデバッグ履歴・ZIP・`demo-records`と、今回の評価D1は別のデータ境界として扱う

`public-debug-record-storage-plan.md`のデバッグ記録を、この評価APIへ自動アップロードしてはいけない。

## 1. D1を作成する（ユーザーのCloudflare操作）

Cloudflare公式のD1作成コマンドは次のとおり。`--location apac`は主配置場所のヒントで、日本国内固定を保証しない。D1のdatabase UUIDは秘密ではないが、実環境の識別子なので、確認せずに別DBへ設定してはいけない。

```powershell
npx.cmd wrangler d1 create cho-ekaki-uta-evaluations --binding EVALUATIONS_DB --location apac
```

出力された`d1_databases`ブロックを確認して、`wrangler.jsonc`へ追加する。

```jsonc
{
  "d1_databases": [
    {
      "binding": "EVALUATIONS_DB",
      "database_name": "cho-ekaki-uta-evaluations",
      "database_id": "<D1_DATABASE_UUID>",
      "migrations_dir": "migrations"
    }
  ]
}
```

`--update-config`で自動追記することもできるが、実行後に`wrangler.jsonc`の差分を確認する。

```powershell
npx.cmd wrangler d1 create cho-ekaki-uta-evaluations --binding EVALUATIONS_DB --location apac --update-config
```

本番configには`preview_database_id`を置かない。Preview D1は本番Workerと混線させないため、`wrangler.staging.jsonc`の`database_id`へ直接設定する。D1 migrationの対象にはdatabase名を使う。binding名は将来変更され得るためである。本番`wrangler.jsonc`で`wrangler dev --remote`を実行してはならない。remote Preview D1を確認する場合は、必ずstaging configを明示する。

公式: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)、[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)

## 2. migrationを作成・確認・適用する

Codexが作成したSQLをレビューしてから、まずローカルDBへ適用する。

```powershell
npx.cmd wrangler d1 migrations list cho-ekaki-uta-evaluations --local
npx.cmd wrangler d1 migrations apply cho-ekaki-uta-evaluations --local
```

ローカルWorkerで確認する場合は、ローカルD1を使う。Preview DBを確認してから本番DBへ進める。

```powershell
npx.cmd wrangler d1 migrations list cho-ekaki-uta-evaluations-preview --remote --config wrangler.staging.jsonc
npx.cmd wrangler d1 migrations apply cho-ekaki-uta-evaluations-preview --remote --config wrangler.staging.jsonc
```

本番適用は明示的に`--remote`を付ける。

```powershell
npx.cmd wrangler d1 migrations list cho-ekaki-uta-evaluations --remote
npx.cmd wrangler d1 migrations apply cho-ekaki-uta-evaluations --remote
```

`migrations apply`は確認プロンプトを表示し、適用前にバックアップを取得する。migrationが失敗した場合、そのmigrationはロールバックされる。適用対象のdatabase名と未適用一覧を確認してから実行する。

## 3. D1の読み取り確認

管理者の手元で、Wrangler経由の読み取りだけを行う。`--json`はCLI結果をJSONで返すが、学習用JSONLの出力ではない。

```powershell
npx.cmd wrangler d1 execute cho-ekaki-uta-evaluations --local --command "SELECT COUNT(*) AS count FROM evaluation_records" --json
npx.cmd wrangler d1 execute cho-ekaki-uta-evaluations --remote --command "SELECT generation_id, status, created_at FROM evaluation_records ORDER BY created_at DESC LIMIT 20" --json
npx.cmd wrangler d1 execute cho-ekaki-uta-evaluations --remote --command "SELECT COUNT(*) AS count FROM evaluation_followups" --json
```

SQLファイルを適用する一回限りの確認には`--file`を使えるが、本番スキーマ変更はmigrationを正規経路とする。

## 4. Worker Secretと型生成

署名receiptの秘密値はGit管理の`vars`に置かず、Worker Secretとして登録する。値は画面やログへ表示しない。

```powershell
npx.cmd wrangler secret put EVALUATION_RECEIPT_SECRET
```

ローカル検証では`.dev.vars`または`.env`を使うが、どちらもGitへコミットしない。現在の本番設定は次の組み合わせで有効化している。

```jsonc
{
  "vars": {
    "LYRICS_PIPELINE_MODE": "phase1",
    "EVALUATION_CENTRAL_STORAGE_ENABLED": "true"
  }
}
```

D1 bindingやrequired secretを設定した後は、Workerの`Env`型を生成する。

```powershell
npx.cmd wrangler types
npx.cmd wrangler types --check
```

公式: [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/)

## 5. 本番有効化前の確認

次の順番で確認する。D1やreceipt secretが未設定なら、公開版の機能フラグは`false`のままにする。

1. TypeScript、専用テスト、通常build、deployment-preview build、`git diff --check`を実行する。
2. ローカルD1へmigrationを適用し、空の評価レコードを作らない読み取り確認を行う。
3. receiptの期限切れ、署名不一致、fingerprint不一致、generation ID不一致をモックテストする。
4. payloadの未知フィールド、画像・音声・raw strokes・氏名・年齢・自由記述、256KiB超過を拒否することを確認する。
5. 同じ`generationId`・同じpayloadの再送が成功することを確認する。
6. 同じ`generationId`・異なるpayloadの再送が409になることを確認する。
7. approvedレコードが再送で上書きされないことを確認する。
8. 同意拒否時に生成・再生が継続し、中央APIへ送信しないことを確認する。
9. 公開版の横画面・スマホ縦画面で、毎回の同意ポップアップが表示されることを確認する。
10. 正常保存を本番前に確認する場合は、別Worker名またはstaging環境を作り、`database_id`自体をPreview D1のUUIDへ向けた専用configを使う。本番configへ`preview_database_id`を置かず、通常の`wrangler deploy`でPreview確認を行わない。

### staging Workerのbuild・deploy

stagingは本番設定を継承しない独立Workerとして扱う。次のコマンドは`wrangler.staging.jsonc`だけを対象にし、`.env.staging`の公開Turnstile Site keyをbundleへ含める。

```powershell
npm.cmd run build:staging
npx.cmd wrangler deploy --config wrangler.staging.jsonc --dry-run
npx.cmd wrangler deploy --config wrangler.staging.jsonc
```

初回deploy前に、次の3つをstaging Worker Secretへ登録する。

- `GEMINI_API_KEY`: 既存のGoogle AI Studio API keyをstaging Workerへ複写する。
- `TURNSTILE_SECRET`: staging hostname専用WidgetのSecretを登録する。
- `EVALUATION_RECEIPT_SECRET`: staging専用に新しく生成し、本番の値を再利用しない。

`wrangler.staging.jsonc`の`secrets.required`により、3つのいずれかが未設定ならdeployを失敗させる。本番にも同じrequired Secret検査を設定済みである。問題が見つかった場合は、`LYRICS_PIPELINE_MODE=legacy`と`EVALUATION_CENTRAL_STORAGE_ENABLED=false`を同時に再deployするか、直前Versionへrollbackする。

評価APIは同一Originだけを受け付け、レスポンスに`Cache-Control: no-store`を付ける。IPベースのレート制限は共有ネットワークへの影響があるため、既定では追加しない。Turnstileの生成トークンを評価APIで再利用しない。

## 6. 承認・除外・JSONL書き出し

管理者APIを公開しない。承認・除外・approved-only exportは、管理者のローカル端末からWrangler remote CLIを実行する設計とする。

```powershell
$env:EVALUATIONS_D1_DATABASE = "cho-ekaki-uta-evaluations"
npm.cmd run evaluation:approve -- <GENERATION_ID> --reviewer=operator
npm.cmd run evaluation:exclude -- <GENERATION_ID> --reviewer=operator --reason="個人情報確認が必要"
npm.cmd run evaluation:export -- --output=approved-evaluations.jsonl
```

Preview DBを操作する場合は各管理コマンドの末尾に`--preview`を加える。このオプションはPreview D1名、`--remote`、`wrangler.staging.jsonc`を自動選択し、本番configの`preview_database_id`へは依存しない。exportは既存ファイルを上書きせず、進捗・エラーを標準エラーへ出す。`approved-evaluations.jsonl`は人が内容を確認してからGCSへ渡す。SFTの出力候補は歌詞だけを見た`firstImpressionSelection`を使い、再生後の`finalPreferenceSelection`、題材確認、4項目評価はmetadataへ残す。承認条件、除外基準、保存期間、削除担当、SFT投入件数はユーザーが決定する。

## 7. 公式資料

- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 Worker API: prepared statements and batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Signing requests with HMAC](https://developers.cloudflare.com/workers/examples/signing-requests/)

## 通常生成と比較評価の切り替え（2026-09-22）

通常は公開版・ローカル版とも歌詞を1候補だけ生成する。候補数の設定が未指定・不正な場合も1候補になる。
比較評価が必要なときだけ `LYRICS_PIPELINE_MODE=phase1` とし、サーバー側の `LYRICS_CANDIDATE_COUNT` とブラウザ側の `VITE_LYRICS_CANDIDATE_COUNT` を両方 `2` に設定し、再起動または再ビルド・デプロイする。

公開版は1候補でも生成完了後に保存同意を毎回確認する。承諾した作品はIndexedDBの「デモ記録」と非公開D1/R2へ保存し、拒否しても再生できる。旧生成経路へのフォールバックや歌声なしの結果にも同じ確認を行う。ローカル開発版の既存の生成前記録確認とローカルサーバーへの保存は維持する。

D1評価・R2作品保管は1～2候補を受け付ける。1候補では第一印象選択をnullとし、比較したという記録を作らない。1段生成のDrawingAnalysisもnull。音声生成に必要な一時処理記録と長期保管は分離する。詳細は [公開生成の暫定仕様](public-generation-parity.md)。
