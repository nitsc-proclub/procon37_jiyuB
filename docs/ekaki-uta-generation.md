# 絵描き歌生成の流れ

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

- 日本語の絵描き歌を作る役割
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

### 1.5 Gemini の応答内容例

実際の成功例では、Gemini からは次のような JSON が返ります。

- `title`: 歌のタイトル
- `lines`: 画面表示用の歌詞。だいたい 4 行
- `singingKanaLines`: VOICEVOX 用の読み上げ歌詞。`lines` と同じ行数
- `identifiedObject`: 絵から推定したモチーフ。例: `にこにこ顔`、`ねこ`、`りんご`
- `lineStrokeMappings`: 各行に対応する stroke group の対応表
- `modelName`: 実際に使った Gemini モデル名。サーバー側で付与される

例:

```json
{
  "title": "にっこりスマイルのうた",
  "lines": [
    "左に ちっちゃな 豆ひとつ",
    "右にも ちっちゃな 豆ひとつ",
    "下に お船を 浮かべたら",
    "にっこり お顔の できあがり"
  ],
  "singingKanaLines": [
    "ひだりに ちっちゃな まめひとつ",
    "みぎにも ちっちゃな まめひとつ",
    "したに おふねを うかべたら",
    "にっこり おかおの できあがり"
  ],
  "identifiedObject": "にこにこ顔",
  "lineStrokeMappings": [
    { "lineIndex": 0, "strokeGroupIds": ["g1"] },
    { "lineIndex": 1, "strokeGroupIds": ["g2"] },
    { "lineIndex": 2, "strokeGroupIds": ["g3"] },
    { "lineIndex": 3, "strokeGroupIds": [] }
  ],
  "modelName": "gemini-3-flash-preview"
}
```

要するに、Gemini は「歌の題名・表示用歌詞・読み上げ用歌詞・絵の解釈・描画との対応」をまとめて返します。

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
- 長音「ー」は1文字につき1モーラ分の長さを確保し、直前の音と同じ音高でつなげる（独立した発音や音高変更はしない）
- 空白は語の区切りとして休符を入れ、句読点などはスキップする

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
const SINGING_BPM = 125;
const PHRASE_BEATS = 8; // 4/4拍子の2小節
```

暫定の既定値と公開版設定は125 BPMで、1行は休符込みで360フレーム（3.84秒）です。内部では十六分音符を1単位として32単位を配分し、最後にフレームへ変換します。125 BPMでは四分音符は45フレームで、八分・十六分音符の端数は累積位置の丸めで処理します。93.75 BPMに設定した場合は八分音符30、四分音符60フレームとなり端数がありません。長い音は十六分音符の整数倍（必要に応じてタイで結ぶ長さ）です。現在は3連符を生成しません。

ローカルの `.env.local` に `VITE_SINGING_BPM=112.5` のように指定するとテンポを変更できます（60〜180、小数可）。変更後はViteを再起動して画面を再読み込みし、歌声を新しく生成してください。保存済みの音声や楽譜は変わりません。Viteの設定なので、ビルド時にも反映されます。

| 設定BPM | 1行のフレーム数 | 1行の秒数 |
| --- | --- | --- |
| 93.75 | 480 | 5.12 |
| 112.5 | 400 | 約4.27 |
| 120 | 375 | 4.00 |
| 125 | 360 | 3.84 |

任意のBPMでは、先に1行の長さを `round(45000 / BPM)` フレームに確定します。次に行頭からの音符終了位置を `round(累積単位数 × 行フレーム数 / 32)` で求め、隣り合う位置の差を `frame_length` にします。これにより全行の長さが一致し、行内の位置誤差は確定した行長に対して最大0.5フレームに収まります。同じ音価でも配置位置によって1フレーム違うことはありますが、累積誤差は増えません。行長自体に端数が出るBPMでは実効テンポがわずかに変わります（例：105指定は429フレーム、実効約104.895 BPM）。上表のBPMでは行長に端数はありません。

音価は、以下の条件を満たす組み合わせを動的計画法で選びます。語ごとの拍数テンプレートと語尾の伸ばしやすさは配分の目安に使い、拍の条件を優先します。

- 各行は拍頭から始め、余裕があれば各モーラを八分音符以上にする。
- 拍の途中で始まった音は、次の拍までに必ず終える。16分位置に入っても、遅くとも3音以内に拍頭へ戻り、ずれを次の拍へ持ち越さない。
- 四分音符より長く伸ばす音は、拍頭から整数拍分だけ伸ばす。文字数が多い場合だけ十六分音符も使う。3連符は使わない。
- 語間の休符は八分音符を目安に調整し、次の語が拍頭または八分位置から始まるようにする。固定の十六分休符で後続をずらさない。
- 長音「ー」も通常のモーラと同じ最低音価を確保する。例えば「ほー」は2モーラ分、「きゃーー」は3モーラ分として配分し、VOICEVOXにはそれぞれ「ほ」「きゃ」の1音にまとめて渡す。余裕のある行なら「ほー」は少なくとも四分音符、「きゃーー」は少なくとも八分音符3個分の長さを持つ。アクセント情報も長音のモーラ数を含めて対応させる。

最終行以外の末尾の息継ぎは4単位です。休符込みで各行を32単位に固定し、曲の先頭の2フレームだけは合成用の余白として小節から除きます。同じ構造の通常行には同じリズムを使い、収まらない歌詞は拍を崩して圧縮せずエラーにします。修正は新しく生成する楽譜と音声に適用され、保存済みの楽譜や音声は変更しません。

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

## 5. 歌詞と描画の同期機能

現在の実装では、歌詞行と描画ストロークの対応は `lineStrokeMappings` と `strokeGroups` を使って既に同期再生されています。`DrawingPlaybackCanvas` は歌声の再生位置から現在の歌詞行を求め、その行に対応する stroke group を左キャンバス上で順番に描画します。

### 5.1 StrokeGroup を作る

現在の `Stroke` は入力操作そのものです。短い線を分けて描いた場合、歌詞行に直接対応させるには細かすぎるため、`DrawingData.strokeGroups` にまとめて扱います。

実装上は、`App.tsx` で raw stroke から `strokeGroups` を作り、Gemini に渡す `DrawingData` に付与します。

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
  length: number;
}
```

初期版では、隣り合う stroke だけを見て結合すれば十分です。

主な結合条件:

- 直前 stroke の終点と次 stroke の始点が近い
- 描画時間の間隔が短い
- bounding box が近い、または重なっている
- 極端に短い線同士で同じ部品に見える

### 5.2 Gemini に対応表を返させる

`LyricsResponse` には、歌詞行と stroke group の対応表である `lineStrokeMappings` が含まれます。

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

サーバー側では、返ってきた対応表を補正します。

- 存在しない group id は除外
- 同じ group id の複数行への重複割り当ては除外
- 行数に足りない mapping は空配列で補完

### 5.3 再生タイミングを計算する

`DrawingPlaybackCanvas` は `SingingScore.notes` の `frame_length` を合計し、歌全体の相対的な時間配分を計算します。

現在の実装では、先頭の短い休符を除いた残りの frame を歌詞行数で等分し、各行の frame 範囲を推定しています。

```txt
lineStartSecond = audio.duration * cumulativeFrames / totalFrames
lineEndSecond = audio.duration * nextCumulativeFrames / totalFrames
```

`audio.currentTime` から現在 frame を計算し、その frame が属する歌詞行を探して、その行に対応する stroke group だけを描画します。`lineStrokeMappings` や `strokeGroups` が存在しない場合は、従来どおり全体の描画軌跡アニメーションに fallback します。

## 6. まとめ

現在の実装は、完成画像だけではなくストローク要約と歌詞行の対応表も Gemini に渡し、その結果を `DrawingPlaybackCanvas` で再生同期に使っている点が重要です。

この構造を活かすことで、歌詞生成・歌声生成・描画同期を 1 つのパイプラインとして扱えます。まずは raw stroke を直接扱うのではなく、前処理で `StrokeGroup` に整えてから LLM に渡す設計が扱いやすいです。
