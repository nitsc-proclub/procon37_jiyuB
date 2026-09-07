# システム全体ドキュメント

このドキュメントは、超えかき歌！の実装全体を俯瞰するための資料です。描画から歌詞生成、歌声生成、保存、デモ閲覧、同期再生までを一つの流れとして整理します。絵から歌詞を作る詳細は [絵描き歌生成の流れ](ekaki-uta-generation.md)、描画軌跡の同期再生は [描画軌跡同期アニメーションと UI](drawing-playback-sync.md)、運用面の詳細は [運用・トラブルシュート](operations.md) を参照してください。

## 1. 概要

超えかき歌！は、ブラウザ上で描いた絵から日本語の絵描き歌を生成し、歌詞と歌声を再生する React アプリです。

主な流れは以下です。

```txt
ユーザーが絵を描く
  ↓
DrawingData と strokeGroups を作成する
  ↓
Gemini で LyricsResponse と lineStrokeMappings を生成する
  ↓
歌詞から SingingScore を作る
  ↓
VOICEVOX Engine で歌声を合成する
  ↓
歌詞と音声、必要に応じて描画同期を表示する
  ↓
必要に応じて demo-records に保存する
```

## 2. 技術スタック

| 項目 | 内容 |
| --- | --- |
| UI | React |
| 言語 | TypeScript |
| ビルドツール | Vite |
| AI API | Google Gemini API |
| Gemini SDK | `@google/genai` |
| 歌声合成 | VOICEVOX Engine |
| ローカル API | Vite middleware |
| 保存先 | `demo-records` |
| 描画同期 | `DrawingPlaybackCanvas.tsx` |

## 3. 主要ファイル

| ファイル | 役割 |
| --- | --- |
| `App.tsx` | アプリ全体の状態管理、ビュー切り替え、生成処理、デモ記録管理 |
| `components/PaintCanvas.tsx` | キャンバス描画、ストローク収集、生成ボタン、再生中の操作ロック |
| `components/DrawingPlaybackCanvas.tsx` | 歌声再生に合わせた描画軌跡の同期表示 |
| `types.ts` | 描画、歌詞、`StrokeGroup`、`LyricsResponse`、`SingingScore`、デモ保存の型定義 |
| `services/geminiService.ts` | フロントエンドから Gemini middleware を呼び出す |
| `server/geminiMiddleware.ts` | Gemini API キー管理、プロンプト作成、ストローク要約、`lineStrokeMappings` 整形 |
| `services/strokeGroupingService.ts` | raw stroke から `StrokeGroup` を作る |
| `services/melodyService.ts` | 歌詞から VOICEVOX 用の `SingingScore` を作る |
| `services/voicevoxService.ts` | VOICEVOX Engine と通信して歌声を合成する |
| `services/voicevoxAccentService.ts` | VOICEVOX のアクセント解析を扱う |
| `services/demoRecordService.ts` | 生成結果保存 API を呼び出す |
| `vite.config.ts` | Vite 設定、VOICEVOX proxy、Gemini/demo-records middleware |

## 4. データ型

描画データは `types.ts` で定義されています。

```ts
export interface Point {
  x: number;
  y: number;
  timestamp: number;
}

export interface Stroke {
  points: Point[];
  startTime: number;
  endTime: number;
}

export interface DrawingData {
  strokes: Stroke[];
  imageUri: string;
  strokeGroups?: StrokeGroup[];
}
```

歌詞生成の結果は `LyricsResponse` です。

```ts
export interface LyricsResponse {
  title: string;
  lines: string[];
  singingKanaLines?: string[];
  identifiedObject: string;
  lineStrokeMappings?: LyricStrokeMapping[];
  modelName?: string;
}
```

歌声合成には `SingingScore` を使います。

```ts
export interface SingingNote {
  lyric: string;
  key: number | null;
  frame_length: number;
}

export interface SingingScore {
  notes: SingingNote[];
}
```

## 5. 描画処理

`PaintCanvas` は、マウスまたはタッチ操作でキャンバス上の座標を記録します。

- ペンを置いた時点で現在のストロークを開始
- 移動中に `Point` を追加
- ペンを離した時点で `Stroke` として確定
- 生成時にキャンバスを `image/png` の Data URI に変換
- 再生中は描画・クリア・再生成などをロックする

生成時に `App.tsx` に渡される値は以下です。

```ts
{
  strokes,
  imageUri
}
```

`App.tsx` は必要に応じて `groupStrokes()` を通し、`strokeGroups` を生成してから Gemini に渡します。

## 6. Gemini 連携

フロントエンドは `services/geminiService.ts` から `/api/gemini/generate-ekaki-uta` に `DrawingData` を送ります。

サーバー側の `server/geminiMiddleware.ts` は以下を行います。

- `.env.local` から Gemini API キーとモデル名を読む
- `DrawingData.imageUri` から base64 画像を取り出す
- `DrawingData.strokeGroups` があればそれを優先し、なければ raw stroke をまとめて要約する
- 各 stroke group を bounding box、中心、サイズ、duration に要約する
- 完成画像とストローク要約を Gemini に送る
- JSON schema で `LyricsResponse` の形を指定する
- 高負荷系エラー時は `GEMINI_MODEL_SUB` にフォールバックする

返却される `LyricsResponse` は、表示用の `lines` と歌声合成用の `singingKanaLines` に加え、必要に応じて `lineStrokeMappings` を含みます。

## 7. 歌声合成

`melodyService` は `LyricsResponse.singingKanaLines` をもとに `SingingScore` を作成します。

現在の実装では、各歌詞行を固定長のフレーズとして扱います。

- BPMは `VITE_SINGING_BPM` で指定（未設定時93.75）。4/4拍子で1行2小節
- 内部は十六分音符単位で管理。行長を固定し、最後に累積位置を丸めてフレームへ変換する（93.75 BPMでは480フレーム、端数なし）
- 先頭に短い休符を追加
- 各モーラに音高と長さを割り当てる
- 最終行の末尾には終止感のある音型を適用する
- `voicevoxAccentService` で行ごとのアクセント傾向を補助的に読む

`voicevoxService` は `SingingScore` を VOICEVOX Engine に送り、2 段階で音声を生成します。

```txt
POST /sing_frame_audio_query?speaker=6000
  ↓
POST /frame_synthesis?speaker=3003
  ↓
音声 Blob
```

開発環境では Vite proxy により `/voicevox` が `http://127.0.0.1:50021` に転送されます。

## 8. 保存処理

保存が有効な場合、生成完了後またはエラー発生後に `demoRecordService.saveDemoRecord` が呼ばれます。

保存される主な内容は以下です。

| ファイル | 内容 |
| --- | --- |
| `input.png` | 入力された完成画像 |
| `voice.wav` など | 生成された歌声 |
| `metadata.json` | 歌詞、ストローク、`strokeGroups`、`SingingScore`、エラー、参加者年齢、モデル名など |

`demo-records` の読み書き API は `vite.config.ts` 内の middleware として実装されています。

`App.tsx` は保存済み記録の一覧取得、詳細取得、お気に入り更新、削除も扱います。

## 9. エラーハンドリング

Gemini では主に以下を扱います。

- API key 未設定
- quota / 429
- network / fetch
- 503 / high demand / overloaded

VOICEVOX では、Engine 未起動や HTTP エラーをユーザー向けメッセージに変換します。

保存処理は失敗しても生成結果自体は画面に残します。保存失敗は toast と開発コンソールで通知します。

## 10. 今後の同期機能の入り口

歌詞に同期して描画軌跡を再生する機能を追加する場合、現状の自然な拡張点は以下です。

- `Stroke` を前処理して `StrokeGroup` を作る
- Gemini に raw stroke ではなく stroke group の要約を渡す
- `LyricsResponse` に歌詞行と stroke group の対応表を追加する
- `SingingScore` の frame 数から歌詞行ごとの再生区間を計算する
- audio の `timeupdate` に合わせて対応 stroke group を描画する

既存の「完成画像 + ストローク要約で歌詞を作る」構造を保ったまま追加できます。
