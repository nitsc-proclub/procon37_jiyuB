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
| VOICEVOX によるアクセント解析 | `services/voicevoxAccentService.ts` |
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
2. VOICEVOX でアクセントを解析する
3. 1行ずつモーラと休符に分解する
4. モーラごとに音の高さと長さを決める
5. VOICEVOX 用の楽譜データ `SingingScore` を作る
6. VOICEVOX API に送って音声を合成する

### 2.1 歌声には singingKanaLines を使う

歌声合成には、Gemini が返した `singingKanaLines` を使います。

```ts
const sourceLines = lyrics.singingKanaLines?.filter((line) => line.trim().length > 0) ?? [];
```

`singingKanaLines` がない場合や空の場合は、歌声用の楽譜を作れないためエラーになります。

### 2.2 メロディ生成の基本方針

メロディは、ランダムな音の並びではなく、絵描き歌らしい短い定型フレーズとして作ります。

基本方針は次の通りです。

| 方針 | 内容 |
| --- | --- |
| 調 | ハ長調 |
| 拍子 | 4/4 拍子 |
| フレーズ単位 | 歌詞の1行を1つのフレーズとして扱う |
| フレーズ長 | 1行を2小節固定にする |
| リズム | 半角スペースで分けたリズム句ごとに拍を配分する |
| 行末 | 行末のモーラは少し長めにする |
| 行間 | 次の行がある場合は、行末の後に一拍ぶんの休符を入れる |
| 終止 | 曲全体の最後の音だけをドにする |
| 音の動き | VOICEVOX のアクセント解析を加味しつつ、フレーズ内の跳躍を少なくする |

この方針により、歌詞の行ごとに同じ長さのまとまりを作りつつ、モーラ数の違いはリズムで吸収します。

### 2.3 seed で再現可能な揺れを作る

メロディ生成にはランダム要素がありますが、完全なランダムではありません。

`createSingingSeed` で、歌詞と `variant` から seed を作ります。

```ts
export const createSingingSeed = (lyrics: LyricsResponse, variant = 0) =>
  `${lyrics.title}::${lyrics.identifiedObject}::${lyrics.lines.join("|")}::${variant}`;
```

この seed を使って疑似乱数を作るため、同じ歌詞・同じ `variant` であれば同じ結果を再現できます。

現在のメロディ生成では、seed を主役にしたランダム選択ではなく、リズムテンプレートや音高候補の同点に近い選択を少し揺らすために使います。

音の高さや長さを決めるときは、主に次の情報を使います。

| 情報 | 使い方 |
| --- | --- |
| 拍子 | 1行を 4/4 拍子の2小節として扱う |
| モーラ数 | 1行内の音の長さを配分する |
| フレーズ内の位置 | 行末の音を少し長めにする |
| 次の行の有無 | 次の行がある場合は、行末後に息継ぎ用の休符を入れる |
| 前後の音 | 音の跳躍を少なくする |
| VOICEVOX アクセント解析 | モーラごとの高低感を音高選択に反映する |
| seed | 同じ歌詞・同じ `variant` から同じ結果を再現する |

### 2.4 1行ごとの長さを固定する

1行の長さは2小節固定です。

```ts
const PHRASE_LENGTH = 330;
const PHRASE_BEATS = 8;
const BREATH_REST_LENGTH = Math.round(PHRASE_LENGTH / PHRASE_BEATS);
const WORD_BREAK_REST_LENGTH = Math.round(BREATH_REST_LENGTH / 4);
```

現在の実装では、2小節という音楽上の長さを、VOICEVOX 用の `frame_length` の合計として扱います。

このプロジェクトでは、1行あたりの合計が `330 frame` になるように、各モーラの長さと休符を調整します。

つまり、`330 frame` を 4/4 拍子の2小節ぶんとして扱います。

| 単位 | 扱い |
| --- | --- |
| 1行 | 1フレーズ |
| 1フレーズ | 2小節 |
| 2小節 | `330 frame` |
| 1拍 | 約 `41 frame` |
| 意味の区切れ | 約 `10 frame` |

次の行がある場合は、フレーズ末に息継ぎ用の休符を入れます。半角スペース由来の短い休符も、同じ `330 frame` の中に含めます。

| 場所 | 扱い |
| --- | --- |
| 通常行 | モーラの音 + スペース休符 + 行末休符 = `330 frame` |
| 最後の行 | モーラの音 + スペース休符 = `330 frame` |

### 2.5 歌詞をモーラと休符に分解する

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

半角スペースは、意味の区切れとして扱います。

AI が返す `singingKanaLines` では、文節のような区切れに半角スペースが入ることがあります。

例:

```txt
おやまが ひとつ ありまして
```

この場合は、次のように扱います。

```txt
お / や / ま / が / 休符 / ひ / と / つ / 休符 / あ / り / ま / し / て
```

スペース由来の休符は短くします。

| 区切れ | 長さ |
| --- | --- |
| 半角スペース | 約 `10 frame` |
| 行末の息継ぎ | 約 `41 frame` |

### 2.6 モーラごとに音の高さを決める

通常のモーラには、ハ長調の中から選んだ3音を割り当てます。

現在は次の3音を使います。

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

この3音は、既存実装から継続して使っている候補です。わらべうたのように限られた音だけで作るメロディでは、どの3音を選ぶかによって印象が大きく変わるため、候補自体は実験で見直せるようにしています。

| 候補 | 状態 |
| --- | --- |
| ミ・ファ・ソ | 既存実装に合わせ、最初に使う候補 |
| ミ・ソ・ラ | 実験候補 |
| レ・ファ・ソ | 実験候補 |

音高を決めるときは、完全なランダムにはしません。

フレーズごとに、一本の線を引いたようなメロディになることを優先します。

| 優先度 | 動き |
| --- | --- |
| 高 | 同じ音を続ける |
| 高 | 隣の候補音へ進む |
| 中 | 小さく上下する |
| 低 | 大きく跳躍する |

現在は、VOICEVOX のトーク用 API をアクセント解析器として使います。

歌唱用の楽譜を作る前に、`singingKanaLines` を VOICEVOX の `/accent_phrases` に送り、アクセント句とモーラごとの `pitch` を取得します。

```http
POST /accent_phrases?speaker=3&text=...
```

返ってくる主な情報は次の通りです。

| 項目 | 内容 |
| --- | --- |
| `accent` | アクセント句内のアクセント位置 |
| `moras[].text` | VOICEVOX が解釈したモーラ |
| `moras[].pitch` | トーク音声として読んだ場合のモーラごとの高さ |
| `pause_mora` | 句の後ろに入るポーズ |

この `pitch` をそのまま MIDI の高さにするわけではありません。

行内の `pitch` を `low` / `mid` / `high` / `neutral` に正規化し、ミ・ファ・ソの候補選択に加点します。

| アクセントレベル | 優先する音 |
| --- | --- |
| `low` | ミ |
| `mid` | ファ |
| `high` | ソ |
| `neutral` | 前後の音との距離を優先 |

`pitch` が `0` のモーラは、VOICEVOX で無声化された音として扱い、`neutral` にします。

アクセント解析に失敗した場合は、アクセント情報なしでメロディを作ります。

この段階では、アクセントに合わせることだけを優先しすぎないようにします。VOICEVOX のアクセント解析は「高くしたい／低くしたい」のヒントとして使い、前後の音との距離も同時に見て、跳躍の少ないメロディにします。

### 2.7 最後はドで終わらせる

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

ドで終わるのは、曲全体の最後だけです。

各行の最後を毎回ドにすると、フレーズごとに終わりすぎてしまい、歌全体が細かく切れて聞こえる可能性があります。

そのため、行末の扱いは次のように分けます。

| 場所 | 長さ | 音高 |
| --- | --- | --- |
| 通常の行末 | 少し長め | 次のフレーズにつながりやすい音 |
| 最後の行末 | さらに長め | ド |

通常の行末では、最後の音の後に一拍ぶんの休符を入れます。

これにより、次の行に入る前に息を吸うような間ができます。

### 2.8 モーラごとに音の長さを決める

音の長さは、半角スペースで分けたリズム句と、その中のモーラ数に応じて決めます。

```ts
const PHRASE_LENGTH = 330;
const PHRASE_BEATS = 8;
const BREATH_REST_LENGTH = Math.round(PHRASE_LENGTH / PHRASE_BEATS);
const WORD_BREAK_REST_LENGTH = Math.round(BREATH_REST_LENGTH / 4);
const MIN_NOTE_LENGTH = 8;
const LONG_VOWEL_WEIGHT_BONUS = 0.4;
const GROUP_END_WEIGHT_BONUS = 0.65;
const FINAL_GROUP_END_WEIGHT_BONUS = 0.35;
const REPEATED_SHORT_WEIGHT = 0.8;
const REPEATED_LONG_WEIGHT = 1.25;
```

現在の実装では、1行2小節の中にモーラと休符が収まるように、半角スペースで分けた意味区切りごとに拍を割り当てます。

1行の中の半角スペースは、リズム句の境界です。

例:

```txt
おやまが ひとつ ありまして
```

この行は、次の3つのリズム句として扱います。

```txt
おやまが / ひとつ / ありまして
```

リズム句の数に応じて、2小節ぶんの8拍を分けます。

| リズム句の数 | 拍の分け方 |
| --- | --- |
| 1句 | `8` |
| 2句 | `4 / 4` |
| 3句 | `2 / 2 / 4` または `2 / 3 / 3` |
| 4句 | `2 / 2 / 2 / 2` |
| 5句 | `1.5 / 1.5 / 1.5 / 1.5 / 2` |
| 6句 | `1 / 1 / 1.5 / 1.5 / 1.5 / 1.5` |

7句以上になった場合は、8拍を句数で均等に割ります。

同じ曲の中で同じ句数の行が出た場合は、同じ拍テンプレートを使います。

これにより、行ごとに完全に違うリズムになるのではなく、似た区切りを持つ行で同じリズム型が反復されます。

各リズム句の中では、短い音の反復と句末長めの形を作ります。

音の長さの考え方は次の通りです。

| 条件 | 長さ |
| --- | --- |
| リズム句に割り当てられた拍が多い | 句内のモーラを長めにする |
| リズム句に割り当てられた拍が少ない | 句内のモーラを短めにする |
| 句の途中のモーラ | 短めにする |
| 3モーラごとの節目 | 少し長めにする |
| リズム句の最後のモーラ | 長めにする |
| 最後の行の最後のモーラ | さらに長めにする |

具体的には、まず各リズム句に frame を配分し、その中で各モーラに重みをつけます。

次の行がある場合は、先に `BREATH_REST_LENGTH` を引きます。

行の中に半角スペースがある場合は、スペースごとに `WORD_BREAK_REST_LENGTH` も引きます。

その残りをモーラへ配分します。

| 行 | モーラへ配分する長さ | 休符 |
| --- | --- | --- |
| 通常行 | `PHRASE_LENGTH - BREATH_REST_LENGTH - スペース休符の合計` | 行末休符 + スペース休符 |
| 最後の行 | `PHRASE_LENGTH - スペース休符の合計` | スペース休符 |

リズム句内のモーラの重みは次の通りです。

| モーラ | 重みの考え方 |
| --- | --- |
| 通常モーラ | `0.8` |
| 3モーラごとの節目 | `1.25` |
| リズム句の最後のモーラ | `+0.65` |
| 最後の行の最後のモーラ | さらに `+0.35` |
| 長音を含むモーラ | 長音1つごとに `+0.4` |

各モーラには最低 `8 frame` を確保し、残りの frame を重みに応じて配分します。

丸め誤差が出た場合は、小数部分が大きいモーラから順に `1 frame` ずつ足します。

通常行では、モーラ・スペース休符・行末休符の合計が必ず `330 frame` になるようにします。最後の行では、モーラ・スペース休符の合計が必ず `330 frame` になるようにします。

### 2.9 VOICEVOX に送る楽譜データ

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

### 2.10 VOICEVOX API に送る

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
| `voice.wav` / `voice.mp3` / `voice.ogg` | 生成された歌声 |
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
VOICEVOX で singingKanaLines のアクセントを解析する
  ↓
singingKanaLines をモーラと休符に分解する
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

歌声化では、Gemini が作った歌詞をそのまま読ませるのではなく、アクセント解析、モーラ分解、休符付与、音高・長さの決定を行い、簡易的な楽譜データに変換してから VOICEVOX に送っています。
