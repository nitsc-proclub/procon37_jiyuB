# 絵かき歌の生成方法

このドキュメントでは、このプロジェクトで「ユーザーが描いた絵」から「絵かき歌の歌詞」を作り、さらに「歌声」に変換するまでの流れを説明します。

## 全体像

このアプリの生成処理は、大きく分けて次の2段階です。

1. 絵から歌詞を作る
2. 歌詞から歌声を作る

処理の中心になるファイルは以下です。

| 役割 | ファイル |
| --- | --- |
| 描画データの取得 | `components/PaintCanvas.tsx` |
| データ型の定義 | `types.ts` |
| Gemini による歌詞生成 | `services/geminiService.ts` |
| 歌詞から楽譜データを作成 | `services/melodyService.ts` |
| VOICEVOX による歌声合成 | `services/voicevoxService.ts` |
| 生成結果の保存 | `services/demoRecordService.ts` |

## 1. 絵から歌詞を作る

### 1.1 キャンバスで描画データを集める

ユーザーがキャンバスに絵を描くと、`PaintCanvas.tsx` がマウスまたはタッチの座標を記録します。

1回の線は `Stroke` として扱います。ペンを置いてから離すまでが1ストロークです。

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

`Point` には、キャンバス上の座標と、その点を記録した時刻が入ります。

例:

```json
{
  "points": [
    { "x": 180, "y": 153, "timestamp": 1777471215782 },
    { "x": 180, "y": 156, "timestamp": 1777471215831 }
  ],
  "startTime": 1777471215782,
  "endTime": 1777471215947
}
```

### 1.2 完成した絵を画像にする

「歌をつくる」ボタンを押すと、キャンバス全体を PNG 画像に変換します。

```ts
const imageUri = canvas.toDataURL("image/png");
onComplete({ strokes, imageUri });
```

このとき作られる `DrawingData` は、ストローク情報と画像をまとめたものです。

```ts
export interface DrawingData {
  strokes: Stroke[];
  imageUri: string;
}
```

つまり、生成処理には次の2つが渡されます。

- 完成した絵の PNG 画像
- 描いた順番や座標を含むストローク情報

### 1.3 Gemini に渡す画像

Gemini には、完成した絵を1枚の PNG 画像として渡します。

`imageUri` は Data URI 形式なので、先頭の `data:image/png;base64,` を取り除き、Base64 部分だけを送ります。

```ts
const base64Image = drawingData.imageUri.split(",")[1];
```

Gemini API には `inlineData` として画像を添付します。

```ts
{
  inlineData: {
    mimeType: "image/png",
    data: base64Image
  }
}
```

そのため、Gemini は完成画像そのものを見て、何が描かれているかを判断できます。

### 1.4 Gemini に渡すストローク情報

ストローク情報も Gemini に渡します。

ただし、Gemini に送るときは、すべての座標点をそのまま送っているわけではありません。`geminiService.ts` の `buildStrokeDescriptions` で、各ストロークを短いテキストに要約します。

```ts
Stroke 1, Bounding Box(180,153 to 250,224), Duration: 165ms
Stroke 2, Bounding Box(...), Duration: ...ms
```

各ストロークについて Gemini に渡している情報は、主に次の3つです。

| 情報 | 意味 |
| --- | --- |
| `Stroke 1` | 何本目に描かれた線か |
| `Bounding Box(...)` | その線がキャンバス上のどの範囲にあるか |
| `Duration` | その線を描くのにかかった時間 |

つまり Gemini には、細かい点列ではなく、「描いた順番」「線の位置」「描画時間」の要約をテキストとして渡しています。

### 1.5 Gemini へのプロンプト

Gemini には、次のような内容を送ります。

```txt
あなたは日本語の絵かき歌を作る作詞家です。
入力された絵とストローク情報を見て、子ども向けの短い絵かき歌を作ってください。

ルール:
1. 4〜6行の歌詞にする
2. 表示用の歌詞とは別に、歌声合成向けのひらがな行も用意する
3. singingKanaLines は lines と同じ行数にする
4. 各行は短めで、リズムに乗せやすい自然な文章にする
5. title と identifiedObject も返す

ストローク数: 4

ストローク情報:
Stroke 1, Bounding Box(180,153 to 250,224), Duration: 165ms
Stroke 2, Bounding Box(...), Duration: ...ms
```

このテキストに加えて、PNG 画像も同じリクエスト内で渡します。

### 1.6 Gemini から受け取る歌詞データ

Gemini には JSON 形式で返すように指定しています。

```ts
export interface LyricsResponse {
  title: string;
  lines: string[];
  singingKanaLines?: string[];
  identifiedObject: string;
  modelName?: string;
}
```

例:

```json
{
  "title": "にこにこねこちゃん",
  "lines": [
    "まあるいおかおをかきまして",
    "おみみをふたつつけましょう",
    "おめめがきらりとわらったら",
    "にこにこねこちゃんできあがり"
  ],
  "singingKanaLines": [
    "まあるいおかおをかきまして",
    "おみみをふたつつけましょう",
    "おめめがきらりとわらったら",
    "にこにこねこちゃんできあがり"
  ],
  "identifiedObject": "ねこ"
}
```

`lines` は画面表示用の歌詞です。

`singingKanaLines` は VOICEVOX で歌わせるための歌詞です。漢字や英字を避け、ひらがな中心にする想定です。

## 2. 歌詞から歌声を作る

歌詞ができたら、次は歌声を作ります。

この処理は次の流れです。

1. `singingKanaLines` を使う
2. 1行ずつモーラに分解する
3. モーラごとに音の高さと長さを決める
4. VOICEVOX 用の楽譜データ `SingingScore` を作る
5. VOICEVOX API に送って音声を合成する

### 2.1 歌声には singingKanaLines を使う

歌声合成には、Gemini が返した `singingKanaLines` を使います。

```ts
const sourceLines = lyrics.singingKanaLines?.filter((line) => line.trim().length > 0) ?? [];
```

`singingKanaLines` がない場合や空の場合は、歌声用の楽譜を作れないためエラーになります。

### 2.2 同じ歌詞なら同じメロディになりやすくする

メロディ生成にはランダム要素がありますが、完全なランダムではありません。

`createSingingSeed` で、歌詞から seed を作ります。

```ts
export const createSingingSeed = (lyrics: LyricsResponse, variant = 0) =>
  `${lyrics.title}::${lyrics.identifiedObject}::${lyrics.lines.join("|")}::${variant}`;
```

この seed を使って疑似乱数を作るため、同じ歌詞であれば同じようなメロディになります。

### 2.3 1行ごとの長さを固定する

1行の長さは固定です。

```ts
const PHRASE_LENGTH = 330;
```

これは「小節数」というより、VOICEVOX 用の `frame_length` の合計です。

このプロジェクトでは、1行あたりの合計が `330 frame` になるように、各モーラの長さと休符を調整します。

### 2.4 歌詞をモーラに分解する

1行の歌詞は、歌わせやすい単位であるモーラに分けます。

例:

```txt
まあるいおかお
```

を、ざっくり次のように扱います。

```txt
ま / あ / る / い / お / か / お
```

小さい「ゃ」「ゅ」「ょ」などは前の文字にくっつけます。

長音「ー」は、前のモーラを伸ばす扱いです。

### 2.5 モーラごとに音の高さを決める

通常のモーラには、次の3音からランダムに音を割り当てます。

```ts
const NOTE_POOL = [64, 65, 67];
```

これは MIDI の音番号です。

| MIDI 番号 | 音 |
| --- | --- |
| 60 | ド |
| 64 | ミ |
| 65 | ファ |
| 67 | ソ |

通常の音は、ミ・ファ・ソのどれかになります。

### 2.6 最後はドで終わらせる

最後の行だけは、歌の終わりらしくなるように終止形を適用します。

```ts
const FINAL_CADENCES = [
  [65, 67, 60],
  [65, 64, 60],
];
```

つまり最後の3音を、次のどちらかにします。

```txt
ファ → ソ → ド
ファ → ミ → ド
```

最後の音は必ず `60`、つまりドになります。

### 2.7 モーラごとに音の長さを決める

音の長さは、候補の中からランダムに選びます。

```ts
const DEFAULT_NOTE_LENGTHS = [12, 18, 24, 30];
const PHRASE_END_NOTE_LENGTHS = [24, 30, 36, 42];
const FINAL_NOTE_LENGTHS = [36, 42, 48, 54];
```

通常の音は短めです。

行末の音は少し長めです。

最後の行の最後の音はさらに長めです。

ただし、自由に長くできるわけではありません。1行の合計が `PHRASE_LENGTH = 330` を超えないように、残りの予算を見ながら長さを選びます。

余った時間は休符として追加します。

```ts
{
  lyric: "",
  key: null,
  frame_length: remainingBudget
}
```

`key: null` は休符を表します。

### 2.8 VOICEVOX に送る楽譜データ

最終的に、VOICEVOX には `SingingScore` を送ります。

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

例:

```json
{
  "notes": [
    { "lyric": "", "key": null, "frame_length": 2 },
    { "lyric": "ま", "key": 64, "frame_length": 18 },
    { "lyric": "あ", "key": 67, "frame_length": 24 },
    { "lyric": "る", "key": 65, "frame_length": 12 },
    { "lyric": "り", "key": 60, "frame_length": 48 }
  ]
}
```

各フィールドの意味は以下です。

| フィールド | 意味 |
| --- | --- |
| `lyric` | 歌わせる文字 |
| `key` | 音の高さ。MIDI 番号。`null` の場合は休符 |
| `frame_length` | 音の長さ |

### 2.9 VOICEVOX API に送る

VOICEVOX への送信は2段階です。

最初に、歌唱クエリを作ります。

```http
POST /sing_frame_audio_query?speaker=6000
Content-Type: application/json
```

body には `SingingScore` を送ります。

次に、返ってきたクエリを使って音声を合成します。

```http
POST /frame_synthesis?speaker=3003
Content-Type: application/json
```

このレスポンスとして、歌声の音声データが返ってきます。

アプリ側では、返ってきたレスポンスを `Blob` にして再生します。

```ts
return synthesisResponse.blob();
```

## 3. 生成結果の保存

データ保存が有効な場合、生成結果は `demo-records` に保存されます。

保存される主な内容は以下です。

| 保存内容 | 説明 |
| --- | --- |
| `input.png` | 入力された完成画像 |
| `voice.wav` | 生成された歌声 |
| `metadata.json` | 歌詞、ストローク、生成年齢、AIモデル名、楽譜情報など |

保存時には、Gemini に送ったストローク要約ではなく、元のストローク生データも `metadata.json` に残します。

```ts
drawing: {
  strokeCount: drawingData.strokes.length,
  strokes: drawingData.strokes
}
```

## 4. まとめ

このプロジェクトの絵かき歌生成は、次のような仕組みです。

```txt
ユーザーが絵を描く
  ↓
キャンバス画像 PNG を作る
  ↓
ストロークを要約テキストにする
  ↓
画像 + ストローク要約を Gemini に送る
  ↓
Gemini が title / lines / singingKanaLines / identifiedObject を返す
  ↓
singingKanaLines をモーラに分解する
  ↓
モーラごとに音の高さと長さを決める
  ↓
VOICEVOX 用の SingingScore を作る
  ↓
VOICEVOX API に送る
  ↓
歌声音声が返ってくる
```

ポイントは、画像だけで歌詞を作っているわけではないことです。

Gemini には、完成画像に加えて「どの線を、どの順番で、どの範囲に描いたか」というストローク要約も渡しています。

歌声化では、Gemini が作った歌詞をそのまま読ませるのではなく、1モーラごとに音の高さと長さを割り当てた簡易的な楽譜データに変換してから VOICEVOX に送っています。
