# 評価データ保存の運用手順（Step 5）

この文書は、Step 5の評価データ中央保存をCloudflare Worker + D1で有効化するときの運用手順である。現時点では中央送信を有効にせず、`wrangler.jsonc`の機能フラグは`false`のままにする。

## 保存境界

中央保存するのは、利用者が毎回同意した最小限の評価メタデータだけとする。

- 保存対象: `generationId`、表示順、候補歌詞、最初の印象の選択、`DrawingAnalysis`、stroke group IDの参照、モデル名・版、同意状態、保存日時
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
      "preview_database_id": "<PREVIEW_D1_DATABASE_UUID>",
      "migrations_dir": "migrations"
    }
  ]
}
```

`--update-config`で自動追記することもできるが、実行後に`wrangler.jsonc`の差分を確認する。

```powershell
npx.cmd wrangler d1 create cho-ekaki-uta-evaluations --binding EVALUATIONS_DB --location apac --update-config
```

`preview_database_id`は、`wrangler dev --remote`で本番DBを誤操作しないためにPreview専用DBを設定する。D1 migrationの対象にはdatabase名を使う。binding名は将来変更され得るためである。

公式: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)、[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)

## 2. migrationを作成・確認・適用する

Codexが作成したSQLをレビューしてから、まずローカルDBへ適用する。

```powershell
npx.cmd wrangler d1 migrations list cho-ekaki-uta-evaluations --local
npx.cmd wrangler d1 migrations apply cho-ekaki-uta-evaluations --local
```

ローカルWorkerで確認する場合は、ローカルD1を使う。Preview DBを確認してから本番DBへ進める。

```powershell
npx.cmd wrangler d1 migrations list cho-ekaki-uta-evaluations --remote --preview
npx.cmd wrangler d1 migrations apply cho-ekaki-uta-evaluations --remote --preview
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
```

SQLファイルを適用する一回限りの確認には`--file`を使えるが、本番スキーマ変更はmigrationを正規経路とする。

## 4. Worker Secretと型生成

署名receiptの秘密値はGit管理の`vars`に置かず、Worker Secretとして登録する。値は画面やログへ表示しない。

```powershell
npx.cmd wrangler secret put EVALUATION_RECEIPT_SECRET
```

ローカル検証では`.dev.vars`または`.env`を使うが、どちらもGitへコミットしない。`wrangler.jsonc`の非秘密feature flagは次のように無効状態を維持する。

```jsonc
{
  "vars": {
    "EVALUATION_CENTRAL_STORAGE_ENABLED": "false"
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
10. 確認後にだけ、機能フラグを`true`へ変更してPreview Workerで送信を確認する。

評価APIは同一Originだけを受け付け、レスポンスに`Cache-Control: no-store`を付ける。IPベースのレート制限は共有ネットワークへの影響があるため、既定では追加しない。Turnstileの生成トークンを評価APIで再利用しない。

## 6. 承認・除外・JSONL書き出し

管理者APIを公開しない。承認・除外・approved-only exportは、管理者のローカル端末からWrangler remote CLIを実行する設計とする。

```powershell
$env:EVALUATIONS_D1_DATABASE = "cho-ekaki-uta-evaluations"
npm.cmd run evaluation:approve -- <GENERATION_ID> --reviewer=operator
npm.cmd run evaluation:exclude -- <GENERATION_ID> --reviewer=operator --reason="個人情報確認が必要"
npm.cmd run evaluation:export -- --output=approved-evaluations.jsonl
```

Preview DBを操作する場合は各コマンドの末尾に`--preview`を加える。exportは既存ファイルを上書きせず、進捗・エラーを標準エラーへ出す。`approved-evaluations.jsonl`は人が内容を確認してからGCSへ渡す。承認条件、除外基準、保存期間、削除担当、SFT投入件数はユーザーが決定する。

## 7. 公式資料

- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 Worker API: prepared statements and batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Signing requests with HMAC](https://developers.cloudflare.com/workers/examples/signing-requests/)
