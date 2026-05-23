# お絵かき歌生成の流れ

このドキュメントは、ユーザーが描いた絵から歌詞を作り、歌声として再生するまでの処理を説明します。歌声に合わせて描画軌跡を再生する UI と同期処理は [描画軌跡同期アニメーションと UI](drawing-playback-sync.md) を参照してください。

## 全体像

生成処理は大きく 2 段階です。

1. 絵から歌詞を作る
2. 歌詞から歌声を作る

```txt
DrawingData
  ↓
Gemini
LyricsResponse
  ↓
melodyService
SingingScore
  ↓
VOICEVOX Engine
audio Blob
```

## 1. 絵から歌詞を作る

### 1.1 キャンバスで描画データを集める

`components/PaintCanvas.tsx` は、ユーザーの描画操作を `Stroke` として記録します。

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
```

1 回の `Stroke` は、ペンを置いてから離すまでの点列です。

生成ボタンを押すと、キャンバス全体を PNG の Data URI に変換し、`DrawingData` として `App.tsx` に渡します。

```ts
export interface DrawingData {
  strokes: Stroke[];
  imageUri: string;
  strokeGroups?: StrokeGroup[];
}
```

`strokeGroups` は必要に応じて `services/strokeGroupingService.ts` で作成される、raw stroke をまとめた補助情報です。

### 1.2 Gemini に渡す画像

`DrawingData.imageUri` は `data:image/png;base64,...` の形式です。

Gemini に送る前に、Data URI のヘッダーを取り除き、base64 部分だけを `inlineData` として渡します。

```ts
{
  inlineData: {
    mimeType: "image/png",
    data: base64Image
  }
}
```

### 1.3 Gemini に渡すストローク情報

すべての点列をそのまま Gemini に送るのではなく、`server/geminiMiddleware.ts` の `buildStrokeDescriptions` で短い説明に変換します。

現在は、`DrawingData.strokeGroups` がある場合はそれを優先し、ない場合は raw stroke をその場でまとめて要約します。

現在渡している情報は以下です。

| 情報 | 内容 |
| --- | --- |
| `Stroke N` | 何番目に描いた線か |
| `Bounding Box` | その線がキャンバス上のどの範囲にあるか |
| `Duration` | その線を描くのにかかった時間 |

例:

```txt
Stroke 1, Bounding Box(180,153 to 250,224), Duration: 165ms
Stroke 2, Bounding Box(120,80 to 155,105), Duration: 92ms
```

この情報により、Gemini は完成画像だけでなく「どの順番で、どのあたりに描いたか」も参考にできます。

### 1.4 Gemini へのプロンプト

Gemini には、以下をまとめて送ります。

- 日本語のお絵かき歌を作る役割
- 4 行程度の短い歌詞にするルール
- 表示用の `lines`
- 歌声合成用の `singingKanaLines`
- 絵に見えるものを `identifiedObject` として返す指定
- ストローク数
- ストローク要約
- 完成画像
- 必要に応じて `lineStrokeMappings`

レスポンスは JSON schema で制御しています。

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

`lines` は画面表示用の歌詞です。

`singingKanaLines` は VOICEVOX に歌わせるためのひらがな中心の歌詞です。`lines` と同じ行数である必要があります。

`lineStrokeMappings` は、各歌詞行に対応する `strokeGroupIds` を返すための補助情報です。

## 2. 歌詞から歌声を作る

### 2.1 singingKanaLines を使う

歌声合成では、Gemini が返した `singingKanaLines` を使います。

```ts
const sourceLines = lyrics.singingKanaLines?.filter((line) => line.trim().length > 0) ?? [];
```

空の場合は `SingingScore` を作れないため、エラーになります。

### 2.2 モーラに分解する

`melodyService` は各行を歌いやすい単位に分解します。

主な処理は以下です。

- 文字を NFKC 正規化する
- 小さい仮名は直前の文字に結合する
- 長音は直前のモーラを伸ばす情報として扱う
- 空白や句読点などはスキップする

例として、歌詞行は内部的に次のような `MoraUnit` の配列になります。

```ts
type MoraUnit = {
  lyric: string;
  extensionCount: number;
};
```

### 2.3 音高と長さを決める

現在の実装では、各行を固定長フレーズとして扱います。

```ts
const PHRASE_LENGTH = 330;
```

各モーラには、以下の情報を割り当てます。

```ts
export interface SingingNote {
  lyric: string;
  key: number | null;
  frame_length: number;
}
```

| フィールド | 内容 |
| --- | --- |
| `lyric` | 歌わせる文字 |
| `key` | MIDI 音高。休符の場合は `null` |
| `frame_length` | 音の長さ |

通常の音高は `NOTE_POOL` から選ばれます。

```ts
const NOTE_POOL = [64, 65, 67];
```

最終行の末尾には、終止感を出すための cadence が適用されます。

```ts
const FINAL_CADENCES = [
  [65, 67, 60],
  [65, 64, 60],
];
```

### 2.4 SingingScore を作る

最終的に VOICEVOX に渡すデータは `SingingScore` です。

```ts
export interface SingingScore {
  notes: SingingNote[];
}
```

先頭には短い休符が追加されます。

```ts
const LEADING_REST_LENGTH = 2;
```

各歌詞行から作った note を順番に結合し、1 つの `SingingScore` として返します。

## 3. VOICEVOX Engine に送る

`services/voicevoxService.ts` は、VOICEVOX Engine と通信して歌声を合成します。

開発環境では base URL は `/voicevox` です。

```ts
const DEV_VOICEVOX_BASE_URL = "/voicevox";
```

Vite proxy が `/voicevox` を `http://127.0.0.1:50021` に転送します。

歌声合成は 2 段階です。

```txt
POST /sing_frame_audio_query?speaker=6000
  ↓
POST /frame_synthesis?speaker=3003
  ↓
Blob
```

返ってきた Blob は `URL.createObjectURL` で再生用 URL に変換され、画面の `<audio>` 要素に渡されます。

## 4. 生成結果の保存

保存が有効な場合、`services/demoRecordService.ts` が `/api/demo-records` に以下を送ります。

- 入力画像の Data URI
- 音声 Blob を Data URI に変換したもの
- メタデータ

メタデータには以下が含まれます。

- 生成ステータス
- 開始時刻と完了時刻
- 参加者年齢
- 使用モデル名
- `LyricsResponse`
- エラー内容
- ストローク情報
- `SingingScore`
- `strokeGroups`
- `lineStrokeMappings`

保存先は既定ではプロジェクトルートの `demo-records` です。

## 5. 歌詞と描画の同期機能を追加する場合

今後、歌詞に同期して描画軌跡を再生したい場合は、次のような拡張が自然です。

### 5.1 StrokeGroup を作る

現在の `Stroke` は入力操作そのものです。短い線を分けて描いた場合、歌詞行に直接対応させるには細かすぎます。

そのため、LLM に渡す前に `StrokeGroup` を作ります。

```ts
export interface StrokeGroup {
  id: string;
  rawStrokeIndexes: number[];
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  startTime: number;
  endTime: number;
}
```

初期版では、隣り合う stroke だけを見て結合すれば十分です。

主な結合条件:

- 直前 stroke の終点と次 stroke の始点が近い
- 描画時間の間隔が短い
- bounding box が近い、または重なっている
- 極端に短い線同士で同じ部品に見える

### 5.2 Gemini に対応表を出させる

`LyricsResponse` に、歌詞行と stroke group の対応表を追加します。

```ts
export interface LyricStrokeMapping {
  lineIndex: number;
  strokeGroupIds: string[];
}
```

レスポンス例:

```json
{
  "title": "ねこのうた",
  "lines": [
    "まあるいおかおをかきまして",
    "おみみをふたつつけましょう"
  ],
  "singingKanaLines": [
    "まあるいおかおをかきまして",
    "おみみをふたつつけましょう"
  ],
  "identifiedObject": "ねこ",
  "lineStrokeMappings": [
    { "lineIndex": 0, "strokeGroupIds": ["g1"] },
    { "lineIndex": 1, "strokeGroupIds": ["g2", "g3"] }
  ]
}
```

### 5.3 再生タイミングを計算する

`SingingScore.notes` の `frame_length` を合計すれば、歌全体の相対的な時間配分が分かります。

まずは以下のように、audio の実再生時間に対する比率で歌詞行の区間を決められます。

```txt
lineStartSecond = audio.duration * cumulativeFrames / totalFrames
lineEndSecond = audio.duration * nextCumulativeFrames / totalFrames
```

`audio` の `timeupdate` を監視し、現在時刻に対応する歌詞行を求め、その行に紐づく stroke group をキャンバス上で順番に再生します。

## 6. まとめ

現在の実装は、完成画像だけではなくストローク要約も Gemini に渡している点が重要です。

この構造を活かせば、歌詞行と描画ストロークの同期情報も同じ生成パイプラインに追加できます。まずは raw stroke を直接扱うのではなく、前処理で `StrokeGroup` に整えてから LLM に渡す設計が扱いやすいです。
