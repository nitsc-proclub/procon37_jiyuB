# 運用・トラブルシュート

このドキュメントは、超えかき歌！を日常的に動かすときに必要な設定、起動方法、保存データの扱い、よくある失敗と確認ポイントをまとめたものです。実装に基づいているため、コードから推測できる運用条件を優先しています。

## 1. 起動に必要なもの

- Node.js
- npm
- Google Gemini API キー
- VOICEVOX Engine

VOICEVOX Engine は開発中、既定で `http://127.0.0.1:50021` で起動している必要があります。

## 2. 開発コマンド

| コマンド | 内容 |
| --- | --- |
| `npm install` | 依存パッケージをインストールする |
| `npm run dev` | 開発サーバーを起動する |
| `npm run build` | 本番用ビルドを作成する |
| `npm run preview` | ビルド結果をローカルで確認する |
| `npm run type-check` | TypeScript の型チェックを行う |

開発サーバーは `http://localhost:3000` で動作します。Vite の設定では `host: 0.0.0.0` になっているため、同一ネットワーク内からのアクセスを受ける前提でも使えます。

## 3. 環境変数

| 変数 | 役割 |
| --- | --- |
| `GEMINI_API_KEY` | Gemini API の認証に使う |
| `GEMINI_MODEL` | 生成に使う第一候補の Gemini モデル名。未指定時は動的候補と `gemini-2.5-flash-lite` を使う |
| `GEMINI_MODEL_SUB` | 最後に試すフォールバック用モデル名 |
| `GEMINI_MODEL_CANDIDATES` | カンマまたは空白区切りの明示的なモデル候補。指定時はこの順序を優先する |
| `DEMO_RECORDS_DIR` | `demo-records` の保存先を変更したいときに使う |
| `VOICEVOX_TIMING_PROFILE` | VOICEVOX サーバー性能ごとのタイミング推定グループ名。変更すると別の推定群として扱う |

`GEMINI_MODEL_CANDIDATES` を省略した場合は、`GEMINI_MODEL` を第一候補にしたうえで Gemini API のモデル一覧を取得し、利用可能な Flash 系モデルを世代・preview・lite などの名前から優先順に並べて試します。`GEMINI_MODEL_SUB` は、その後に試す最後の保険として扱います。

## 4. 起動時の内部構成

- 開発時は `server/geminiMiddleware.ts` と `demo-records` API が Vite middleware として読み込まれる
- `configurePreviewServer` にも同じ middleware が載るため、`vite preview` でも API を確認できる
- 開発時の VOICEVOX 通信は `/voicevox` を `http://127.0.0.1:50021` に proxy する
- 本番ビルドでは VOICEVOX proxy は無効になる
- 開発時のみ CORS が有効になる

## 5. 保存データ

保存先の既定値はプロジェクトルートの `demo-records` です。`DEMO_RECORDS_DIR` を設定すると、別ディレクトリに保存できます。

1 件のデモ記録には、以下が保存されます。

- `input.png` などの入力画像
- `voice.wav`、`voice.mp3`、`voice.ogg` のいずれかの音声ファイル
- `metadata.json`

`metadata.json` には、少なくとも次の情報が含まれます。

- `schemaVersion`
- `recordId`
- `savedAt`
- `status`
- `favorite`
- `files`
- `mimeTypes`
- `lyrics`
- `drawing`
- `singingScore`
- `participantAge`
- `participant`
- `aiModel`
- `error`

`drawing` の中には、描画ストロークと `strokeGroups` が入ります。歌詞生成が成功した記録では、歌詞の実体も保存されます。

`generation-timings.json` は匿名の生成時間メトリクス専用ファイルです。最大 300 件を保持し、絵・歌詞・音声・年齢は含みません。

## 6. デモ記録 API

`vite.config.ts` の middleware が `demo-records` を API として公開します。

| メソッド | パス | 役割 |
| --- | --- | --- |
| `GET` | `/api/demo-records` | 一覧を取得する |
| `GET` | `/api/demo-records/:recordId` | 詳細を取得する |
| `GET` | `/api/demo-records/:recordId/image` | 入力画像を取得する |
| `GET` | `/api/demo-records/:recordId/audio` | 音声を取得する |
| `POST` | `/api/demo-records` | 新規保存する |
| `GET` | `/api/demo-records/timing-estimates` | 匿名の生成時間推定を取得する |
| `POST` | `/api/demo-records/timings` | 匿名の生成時間メトリクスを保存する |
| `PATCH` | `/api/demo-records/:recordId` | お気に入り状態を更新する |
| `DELETE` | `/api/demo-records/:recordId` | 記録を削除する |

一覧表示では、`success` で、かつ画像と歌詞を持つ記録だけが並びます。壊れたメタデータや一部欠損した古い記録は一覧から落ちます。

## 7. よくある失敗

### Gemini API キーがない

生成時に `GEMINI_API_KEY が設定されていません。.env.local を確認してください。` というエラーになります。

確認ポイント:

- `.env.local` が存在するか
- `GEMINI_API_KEY` が空ではないか
- 開発サーバーを再起動したか

### Gemini の利用上限や高負荷

Gemini 側の 429 や quota エラーでは、利用上限に達した旨のメッセージになります。503 や overloaded 系では `GEMINI_MODEL_SUB` にフォールバックします。

確認ポイント:

- しばらく置いて再試行する
- `GEMINI_MODEL` / `GEMINI_MODEL_SUB` の値を見直す
- 画像サイズや入力が大きすぎないか確認する

### VOICEVOX に接続できない

`VOICEVOX Engine に接続できません。開発中は Vite サーバーを再起動し、VOICEVOX Engine が 127.0.0.1:50021 で動いているか確認してください。` というエラーになります。

確認ポイント:

- VOICEVOX Engine が起動しているか
- ポート 50021 が他のアプリに使われていないか
- Vite 開発サーバーを再起動したか

### デモ記録が保存されない

保存 API は `imageDataUri` と `metadata` を受け取り、必要に応じて `audioDataUri` を保存します。音声がなくても画像とメタデータは保存されます。

確認ポイント:

- `demo-records` ディレクトリに書き込み権限があるか
- `DEMO_RECORDS_DIR` を設定しているなら、存在する場所を指しているか
- JSON に壊れた値が混じっていないか

### 保存済み記録が一覧に出ない

一覧は成功記録のみを対象にし、画像と歌詞が存在するものだけを返します。エラー保存や途中失敗の記録は一覧から除外されます。

## 8. 画面運用の注意

- 音声再生中は描画編集がロックされる
- 生成中もキャンバス操作はロックされる
- デモ記録ビューでは、一覧取得後に詳細表示や削除、お気に入り更新を行う
- 同期再生では、古い記録や対応情報のない記録は全体再生にフォールバックする

## 9. 参考実装

- [App.tsx](../App.tsx)
- [services/demoRecordService.ts](../services/demoRecordService.ts)
- [server/geminiMiddleware.ts](../server/geminiMiddleware.ts)
- [vite.config.ts](../vite.config.ts)
- [services/voicevoxService.ts](../services/voicevoxService.ts)
