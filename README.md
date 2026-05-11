# お絵かき歌メーカー

ユーザーがブラウザ上で描いた絵をもとに、Google Gemini が日本語の「お絵かき歌」の歌詞を生成し、VOICEVOX Engine で歌声に変換する Web アプリケーションです。

## セットアップ

### 必要なもの

- Node.js
- npm
- Google Gemini API キー
- VOICEVOX Engine

VOICEVOX Engine は開発時に `http://127.0.0.1:50021` で起動しておく必要があります。

### インストール

```bash
npm install
```

`.env.local.example` を参考に `.env.local` を作成し、Gemini API キーを設定します。

```env
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-3-flash-preview
GEMINI_MODEL_SUB=gemini-2.5-flash-lite
```

## 開発

```bash
npm run dev
```

ブラウザで `http://localhost:3000` を開きます。

主な npm script は以下です。

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | Vite 開発サーバーを起動 |
| `npm run build` | 本番用ビルドを作成 |
| `npm run preview` | ビルド結果をローカルで確認 |
| `npm run type-check` | TypeScript の型チェック |

## 主な機能

- ブラウザ上のキャンバスに自由に描画
- 描画画像とストローク情報を Gemini に送信
- 4 行程度のお絵かき歌を自動生成
- 歌声合成用のひらがな歌詞 `singingKanaLines` を生成
- 歌詞から簡易的な `SingingScore` を作成
- VOICEVOX Engine で歌声を合成
- 生成結果を `demo-records` に保存
- 保存済みデモを一覧から読み込み

## プロジェクト構成

```txt
.
├── App.tsx
├── components/
│   └── PaintCanvas.tsx
├── docs/
│   ├── ekaki-uta-generation.md
│   └── system-overview.md
├── server/
│   └── geminiMiddleware.ts
├── services/
│   ├── demoRecordService.ts
│   ├── geminiService.ts
│   ├── melodyService.ts
│   ├── voicevoxAccentService.ts
│   └── voicevoxService.ts
├── types.ts
└── vite.config.ts
```

## 処理の流れ

1. `PaintCanvas` が描画ストロークと完成画像を `DrawingData` として作成します。
2. `geminiService` が `DrawingData` を `/api/gemini/generate-ekaki-uta` に送ります。
3. `server/geminiMiddleware.ts` が Gemini API を呼び、`LyricsResponse` を返します。
4. `melodyService` が `singingKanaLines` から `SingingScore` を作ります。
5. `voicevoxService` が VOICEVOX Engine に `SingingScore` を送り、音声 Blob を取得します。
6. `App.tsx` が歌詞と音声プレイヤーを表示します。
7. 保存が有効な場合、`demoRecordService` が入力画像、音声、メタデータを `demo-records` に保存します。

## ドキュメント

- [システム全体の概要](docs/system-overview.md)
- [お絵かき歌生成の流れ](docs/ekaki-uta-generation.md)

## 注意点

- `.env.local` は Git 管理しません。
- Gemini API キーはブラウザに埋め込まず、Vite middleware 側で扱います。
- `demo-records` 保存 API は Vite middleware です。本番ホスティングにそのまま置く場合は、別途 API サーバーや serverless function への移植が必要です。
- 既存ドキュメントは UTF-8 の日本語として保存しています。
