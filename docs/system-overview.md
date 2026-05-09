# システム全体ドキュメント

このドキュメントでは、絵かき歌の生成アルゴリズム以外の、プロジェクト全体の技術構成・実行フロー・外部サービス連携・保存処理をまとめます。

絵から歌詞を作る方法、歌詞から歌声を作る方法の詳細は `docs/ekaki-uta-generation.md` を参照してください。

## 1. プロジェクト概要

このプロジェクトは、ブラウザ上で絵を描き、その絵をもとに歌詞と歌声を生成する Web アプリです。

アプリ本体は React で実装されています。開発サーバーとビルドには Vite を使います。

外部サービスとして、歌詞生成に Gemini、歌声合成に VOICEVOX Engine を使います。

## 2. 技術スタック

| 項目 | 内容 |
| --- | --- |
| UI | React |
| 言語 | TypeScript |
| ビルドツール | Vite |
| AI API | Google Gemini API |
| Gemini SDK | `@google/genai` |
| 歌声合成 | VOICEVOX Engine |
| 保存 API | Vite middleware |
| 保存先 | ローカルの `demo-records` ディレクトリ |

主な npm script は以下です。

```bash
npm run dev
npm run build
npm run preview
npm run type-check
```

## 3. ディレクトリ構成

```txt
.
├── App.tsx
├── index.tsx
├── index.html
├── types.ts
├── vite.config.ts
├── components/
│   └── PaintCanvas.tsx
├── services/
│   ├── geminiService.ts
│   ├── melodyService.ts
│   ├── voicevoxService.ts
│   └── demoRecordService.ts
├── docs/
│   ├── ekaki-uta-generation.md
│   └── system-overview.md
└── demo-records/
```

主な役割は以下です。

| ファイル | 役割 |
| --- | --- |
| `App.tsx` | アプリ全体の状態管理、生成処理の流れ、画面表示 |
| `components/PaintCanvas.tsx` | 描画キャンバス、年齢入力、生成ボタン |
| `types.ts` | 描画データ、歌詞、楽譜データの型定義 |
| `services/geminiService.ts` | Gemini API との通信 |
| `services/melodyService.ts` | 歌詞から VOICEVOX 用の楽譜データを作成 |
| `services/voicevoxService.ts` | VOICEVOX Engine との通信 |
| `services/demoRecordService.ts` | 生成結果保存 API の呼び出し |
| `vite.config.ts` | Vite 設定、VOICEVOX proxy、保存用 middleware |

## 4. 実行環境

### 4.1 必要なもの

- Node.js
- npm
- Gemini API key
- VOICEVOX Engine

VOICEVOX Engine は、通常 `http://127.0.0.1:50021` で起動している必要があります。

### 4.2 環境変数

`.env.local.example` には以下の値があります。

```env
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-3-flash-preview
GEMINI_MODEL_SUB=gemini-2.5-flash-lite
```

| 変数 | 用途 |
| --- | --- |
| `GEMINI_API_KEY` | Gemini API の認証キー |
| `GEMINI_MODEL` | 通常使う Gemini モデル |
| `GEMINI_MODEL_SUB` | 高負荷時などに使う予備モデル |
| `DEMO_RECORDS_DIR` | 保存先ディレクトリを変更したい場合に使う任意設定 |

`vite.config.ts` で `loadEnv` した値を、フロントエンドの `process.env.*` として埋め込んでいます。

```ts
define: {
  "process.env.GEMINI_API_KEY": JSON.stringify(env.GEMINI_API_KEY),
  "process.env.GEMINI_MODEL": JSON.stringify(env.GEMINI_MODEL),
  "process.env.GEMINI_MODEL_SUB": JSON.stringify(env.GEMINI_MODEL_SUB),
}
```

## 5. アプリ全体の処理フロー

ユーザー操作から音声再生までの大まかな流れは以下です。

```txt
ユーザーがキャンバスに絵を描く
  ↓
PaintCanvas が DrawingData を作る
  ↓
App.handleComplete が生成処理を開始する
  ↓
Gemini で歌詞を生成する
  ↓
歌詞から SingingScore を作る
  ↓
VOICEVOX Engine で歌声を合成する
  ↓
音声 Blob から object URL を作る
  ↓
audio 要素で再生する
  ↓
必要に応じて demo-records に保存する
```

`App.tsx` の `handleComplete` が、この一連の処理の中心です。

処理中は `isGenerating`、`progressValue`、`progressLabel` を更新し、画面上に進捗を表示します。

## 6. フロントエンド構成

### 6.1 状態管理

状態管理には React の `useState` と `useRef` を使っています。

`App.tsx` が持つ主な状態は以下です。

| state | 内容 |
| --- | --- |
| `lyrics` | 生成された歌詞 |
| `error` | エラーメッセージ |
| `isGenerating` | 生成中かどうか |
| `audioUrl` | 再生用の音声 URL |
| `shouldAutoplay` | 生成後に自動再生するか |
| `progressValue` | 進捗率 |
| `progressLabel` | 進捗メッセージ |
| `saveToast` | 保存結果の通知 |
| `participantAge` | 参加者の年齢 |
| `isDataSavingEnabled` | 生成結果を保存するか |

### 6.2 音声 URL の管理

VOICEVOX から返ってきた音声は `Blob` です。

ブラウザで再生するため、`URL.createObjectURL` で一時 URL を作ります。

古い Blob URL は `URL.revokeObjectURL` で解放するようになっています。

### 6.3 画面構成

画面は大きく2カラムです。

| 領域 | 内容 |
| --- | --- |
| 左側 | 描画キャンバス、年齢入力、生成ボタン、クリアボタン |
| 右側 | 生成中の進捗、完成した歌詞、音声プレイヤー |

生成中は右側に進捗バーを表示し、完了後は歌詞と audio controls を表示します。

## 7. 外部サービス連携

### 7.1 Gemini

Gemini 連携は `services/geminiService.ts` にまとまっています。

主な役割は以下です。

- API key とモデル名を環境変数から読む
- 描画データを Gemini に送る
- JSON schema 付きで返答形式を制御する
- 高負荷系エラーの場合に予備モデルへ fallback する
- 返ってきた JSON を `LyricsResponse` として扱う

生成方法の詳細は `docs/ekaki-uta-generation.md` に分けています。

### 7.2 VOICEVOX Engine

VOICEVOX 連携は `services/voicevoxService.ts` にまとまっています。

開発時は Vite proxy 経由で `/voicevox` に送ります。

```ts
const DEV_VOICEVOX_BASE_URL = "/voicevox";
```

本番モードでは直接 `http://127.0.0.1:50021` に送ります。

```ts
const PROD_VOICEVOX_BASE_URL = "http://127.0.0.1:50021";
```

VOICEVOX API への送信は2段階です。

```txt
POST /sing_frame_audio_query?speaker=6000
  ↓
POST /frame_synthesis?speaker=3003
  ↓
音声 Blob
```

`speaker=6000` は歌唱クエリ作成用、`speaker=3003` はフレーム合成用として使われています。

### 7.3 Vite proxy

ブラウザから直接 `127.0.0.1:50021` にアクセスすると CORS や Origin の問題が出る場合があります。

開発時は `vite.config.ts` の proxy 設定で、`/voicevox` へのリクエストを VOICEVOX Engine に転送します。

```ts
"/voicevox" -> "http://127.0.0.1:50021"
```

proxy では `Origin` ヘッダーも `http://127.0.0.1:50021` に合わせています。

## 8. 生成結果の保存

### 8.1 保存の入口

保存処理のフロント側は `services/demoRecordService.ts` です。

生成完了後、または生成エラー後に、`App.tsx` から `saveDemoRecord` を呼びます。

送信先は以下です。

```http
POST /api/demo-records
Content-Type: application/json
```

送る payload は以下です。

```ts
{
  imageDataUri: drawingData.imageUri,
  audioDataUri: audioBlob ? await blobToDataUri(audioBlob) : null,
  metadata
}
```

### 8.2 保存 API の実体

`/api/demo-records` は独立したバックエンドではなく、`vite.config.ts` に定義された Vite middleware です。

middleware は開発サーバーと preview サーバーの両方に追加されています。

```ts
configureServer(server) {
  server.middlewares.use(createDemoRecordMiddleware(demoRecordsDir));
}

configurePreviewServer(server) {
  server.middlewares.use(createDemoRecordMiddleware(demoRecordsDir));
}
```

### 8.3 保存先

デフォルトでは、プロジェクトルートの `demo-records` に保存します。

保存先を変更したい場合は、環境変数 `DEMO_RECORDS_DIR` を使います。

### 8.4 保存されるファイル

1回の生成ごとに、`demo-records` 内にディレクトリが作られます。

ディレクトリ名には以下が含まれます。

- 保存日時
- 成功またはエラー
- 歌詞タイトル
- ランダム ID

保存されるファイルは以下です。

| ファイル | 内容 |
| --- | --- |
| `input.png` | 入力画像 |
| `voice.wav` / `voice.mp3` / `voice.ogg` | 生成音声。MIME type によって拡張子が変わる |
| `metadata.json` | 歌詞、ストローク、楽譜、エラー、年齢、モデル名など |

保存 API は最大リクエストサイズを `100MB` に制限しています。

```ts
const MAX_RECORD_REQUEST_BYTES = 100 * 1024 * 1024;
```

## 9. エラーハンドリング

### 9.1 Gemini

Gemini で主に扱っているエラーは以下です。

| 種類 | 対応 |
| --- | --- |
| API key 未設定 | ユーザー向けエラーを出す |
| 429 / quota | 利用制限のエラーとして扱う |
| network / fetch | ネットワークエラーとして扱う |
| 503 / high demand / overloaded | 予備モデルがあれば fallback する |

### 9.2 VOICEVOX

VOICEVOX Engine に接続できない場合は、`fetch` が `TypeError` になるため、VOICEVOX Engine の起動確認を促すエラーに変換します。

また、HTTP response が `ok` でない場合は、ステータスコードと response text を含めてエラーにします。

### 9.3 保存処理

保存に失敗しても、歌詞や音声の生成結果自体は画面に残ります。

保存失敗時は toast で通知し、開発環境では console に詳細を出します。

## 10. データの流れ

主要なデータ型の流れは以下です。

```txt
DrawingData
  ↓ Gemini
LyricsResponse
  ↓ melodyService
SingingScore
  ↓ VOICEVOX
Blob
  ↓ URL.createObjectURL
audioUrl
```

保存時は、これらの一部をまとめて `metadata.json` に残します。

```txt
DrawingData
LyricsResponse
SingingScore
audioBlob
error
participantAge
aiModel
```

## 11. 開発時の注意点

### 11.1 VOICEVOX Engine を起動しておく

歌声合成にはローカルの VOICEVOX Engine が必要です。

開発時は Vite の proxy を使いますが、転送先である `127.0.0.1:50021` の VOICEVOX Engine は別途起動しておく必要があります。

### 11.2 API key は `.env.local` に置く

Gemini API key は `.env.local` に置きます。

`.env.local` は `.gitignore` に入っているため、通常は Git 管理されません。

### 11.3 一部ファイルに文字化けがある

現状のソースコードや README には、一部日本語文字列が文字化けしている箇所があります。

処理の構造自体は読み取れますが、UI 表示文言やエラーメッセージを整備する場合は、文字コードまたは元文言の復元が必要です。

### 11.4 保存 API は Vite middleware

`/api/demo-records` は本番用の独立 API サーバーではありません。

Vite dev / preview では動きますが、静的ホスティングにそのまま置くだけでは保存 API は動きません。

本番運用で保存機能を使う場合は、別途 API サーバーや serverless function などに移す必要があります。

## 12. 関連ドキュメント

- `docs/ekaki-uta-generation.md`: 絵から歌詞を作り、歌詞から歌声を作る生成方法の詳細
- `README.md`: セットアップや基本的な開発コマンド
