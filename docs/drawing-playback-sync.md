# 描画軌跡同期アニメーションと UI

このドキュメントは、歌声の再生に合わせて左キャンバス上で絵の軌跡を再生する仕組みを説明します。

## 1. 目的

絵描き歌では、歌詞の各行が「どの部品を描くか」に対応します。

この機能では、歌声の現在時刻から「今歌っている行」を求め、その行に対応する描画ストロークだけを左キャンバス上で順番に描画します。

```txt
audio.currentTime
  ↓
SingingScore の frame 位置に変換
  ↓
現在の歌詞行を判定
  ↓
lineStrokeMappings から stroke group を取得
  ↓
対応する軌跡を距離ベースで途中まで描画
```

## 2. 関連ファイル

| ファイル | 役割 |
| --- | --- |
| `components/DrawingPlaybackCanvas.tsx` | 再生中の描画アニメーションを canvas に描く |
| `components/PaintCanvas.tsx` | 左キャンバス。再生中は編集キャンバスの上に再生用 canvas を重ねる |
| `App.tsx` | 音声再生状態、表示モード、同期用データを管理する |
| `services/strokeGroupingService.ts` | raw stroke を `StrokeGroup` にまとめる |
| `server/geminiMiddleware.ts` | Gemini に stroke group 情報を渡し、歌詞行との対応表を生成する |
| `types.ts` | `StrokeGroup`、`LyricStrokeMapping` などの型定義 |

## 3. データ構造

### 3.1 Raw Stroke

`Stroke` はユーザーの入力操作そのものです。

```ts
export interface Stroke {
  points: Point[];
  startTime: number;
  endTime: number;
}
```

1 回ペンを置いてから離すまでが 1 stroke です。

### 3.2 StrokeGroup

`StrokeGroup` は、AI と再生処理が扱いやすいように raw stroke をまとめた単位です。

```ts
export interface StrokeGroup {
  id: string;
  rawStrokeIndexes: number[];
  bounds: StrokeBounds;
  startTime: number;
  endTime: number;
  length: number;
}
```

`rawStrokeIndexes` は 0-based です。Gemini に渡す説明文では、ユーザーに読みやすいよう 1-based に変換しています。

### 3.3 LyricStrokeMapping

`LyricStrokeMapping` は「歌詞の一行」と「その行で描く stroke group」の対応表です。

```ts
export interface LyricStrokeMapping {
  lineIndex: number;
  strokeGroupIds: string[];
}
```

例:

```json
[
  { "lineIndex": 0, "strokeGroupIds": ["g1"] },
  { "lineIndex": 1, "strokeGroupIds": ["g2", "g3"] },
  { "lineIndex": 2, "strokeGroupIds": ["g4"] },
  { "lineIndex": 3, "strokeGroupIds": [] }
]
```

最後の行が「できあがり」「これは○○」のような完成宣言であれば、`strokeGroupIds` は空配列でも構いません。

## 4. StrokeGroup の作成

`services/strokeGroupingService.ts` の `groupStrokes()` が raw stroke を `StrokeGroup[]` に変換します。

初期実装では、隣り合う stroke だけを結合候補にします。

主な結合条件:

- 直前 stroke の終点と次 stroke の始点が近い
- stroke 間の時間差が短い
- bounding box が近い
- どちらかが短い stroke で、同じ部品の描き足しに見える

この処理は、極端に不規則な描画順を並べ替えるものではありません。基本的には、ユーザーが自然な絵描き歌の順序で描くことを前提にしています。

## 5. Gemini による対応表生成

生成時、`App.tsx` は `DrawingData` に `strokeGroups` を付けて Gemini API に送ります。

```ts
const groupedDrawingData = {
  ...data,
  strokeGroups: groupStrokes(data.strokes),
};
```

`server/geminiMiddleware.ts` は、完成画像と stroke group の要約を Gemini に渡します。

例:

```txt
Group g1, Raw strokes: 1,2, Bounding Box(120,80 to 260,220), Center(190,150), Size(140x140), Duration: 850ms
Group g2, Raw strokes: 3, Bounding Box(90,60 to 130,100), Center(110,80), Size(40x40), Duration: 220ms
```

Gemini には以下を求めています。

- `lines`
- `singingKanaLines`
- `identifiedObject`
- `lineStrokeMappings`

サーバー側では、返ってきた `lineStrokeMappings` を補正します。

- 存在しない group id は除外
- 同じ group id の複数行への重複割り当ては除外
- mapping が足りない行は空配列として補完

## 6. 音声と歌詞行の同期

歌声合成に使う `SingingScore` は、VOICEVOX 用の note 配列です。

```ts
export interface SingingNote {
  lyric: string;
  key: number | null;
  frame_length: number;
}
```

再生中は、audio の実秒数を `SingingScore` の frame に変換します。

```ts
const totalFrames = score.notes.reduce((sum, note) => sum + note.frame_length, 0);
const currentFrame = (audio.currentTime / audio.duration) * totalFrames;
```

現在の `melodyService` は、先頭の短い休符のあと、歌詞 1 行をほぼ固定長のフレーズとして積みます。

そのため、行ごとの frame 範囲は以下の考え方で作れます。

```ts
const leadingRestFrames = firstNoteIsRest ? score.notes[0].frame_length : 0;
const phraseFrameLength = (totalFrames - leadingRestFrames) / lineCount;

lineStartFrame = leadingRestFrames + phraseFrameLength * lineIndex;
lineEndFrame = leadingRestFrames + phraseFrameLength * (lineIndex + 1);
```

`DrawingPlaybackCanvas` はこの frame 範囲を使い、`requestAnimationFrame` で毎フレーム再描画しながら現在の歌詞行を判定します。

## 7. 軌跡の描画

描画アニメーションは、点の数ではなく線分距離ベースで進みます。

各 stroke は次のような `PathSegment` に変換されます。

```ts
type PathSegment =
  | { type: "line"; from: Point; to: Point; startLength: number; length: number }
  | { type: "dot"; point: Point; startLength: number; length: number };
```

現在の進捗から、描くべき長さを計算します。

```ts
const visibleLength = totalLength * progress;
```

線分の途中まで描く場合は、始点と終点を線形補間します。

```ts
const ratio = remainingLength / segmentLength;
const x = from.x + (to.x - from.x) * ratio;
const y = from.y + (to.y - from.y) * ratio;
```

## 8. 行同期アニメーション

`lineStrokeMappings`、`strokeGroups`、`SingingScore` がそろっている場合、アニメーションは行ごとに同期します。

1. 現在の audio 時刻から `currentFrame` を計算
2. `currentFrame` が含まれる歌詞行を探す
3. その行までに対応する stroke group を描画する
4. 過去の行の stroke group は 100% 描画済みにする
5. 現在の行の stroke group は、行内進捗ぶんだけ描く
6. 未来の行の stroke group はまだ描かない

同期表示が有効なときは、`DrawingPlaybackCanvas` が `lineTimings` と `groupPathMap` を使って、行ごとの描画進捗を毎フレーム更新します。

1 行に複数の stroke group がある場合、それらは同時に伸びるのではなく、その行の中で順番に描かれます。

```txt
line 1: g1
line 2: g2, g3
line 3: g4
line 4: none
```

この場合、2 行目の中では `g2` が描かれてから `g3` が描かれます。

## 9. Fallback

古い demo-records など、`lineStrokeMappings` が存在しないデータでは、従来の全体アニメーションに fallback します。

```txt
audio.currentTime / audio.duration
  ↓
絵全体のパス長に対する進捗
```

この fallback では、歌詞行との対応は見ず、すべての raw stroke を先頭から順番に描きます。

## 10. UI の挙動

### 10.1 左キャンバスに表示する

再生中のアニメーションは、右側の歌詞パネルではなく左の `PaintCanvas` 上に表示します。

`PaintCanvas` は通常の編集 canvas を保持したまま、その上に `DrawingPlaybackCanvas` を重ねます。

```txt
PaintCanvas container
  ├─ editing canvas
  ├─ playback overlay canvas
  └─ generating overlay
```

### 10.2 再生中は編集をロックする

音声再生中は、左キャンバスへの操作をロックします。

ロックされる操作:

- 描画
- クリア
- undo / redo
- 再生成
- 年齢入力の連続変更

一時停止または再生終了するとロックは解除されます。

### 10.3 再生成しない書き足しは反映されない

再生停止後、ユーザーは左キャンバスに書き足せます。

ただし、再生成せずにもう一度音声を再生した場合、アニメーションと完成絵は「最後に生成または読み込んだ `DrawingData`」を使います。

つまり、書き足し分は次に生成するまで再生アニメーションには反映されません。

これは、音声・歌詞・stroke mapping が生成時点の描画データと対応しているためです。

## 11. 表示モード

音声プレイヤー上部に表示モード切り替えがあります。

| モード | 挙動 |
| --- | --- |
| `アニメーション` | 歌声再生中に左キャンバス上で軌跡を描く |
| `完成絵` | 歌声再生中に左キャンバス上へ完成画像を表示する |

デフォルトは `アニメーション` です。

`完成絵` モードでも、再生中は編集キャンバスをロックします。

## 12. 保存される情報

`demo-records` の `metadata.json` には、同期再生に必要な情報が保存されます。

```ts
drawing: {
  strokeCount: number;
  strokes: Stroke[];
  strokeGroups?: StrokeGroup[];
}

lyrics: {
  ...
  lineStrokeMappings?: LyricStrokeMapping[];
}

singingScore: SingingScore | null;
```

これにより、保存済み demo-records を読み込んだ場合でも、同期アニメーションを再現できます。

## 13. 現在の前提と制約

- 歌詞行の時間範囲は `SingingScore` から推定している
- 現在の melody 実装は、各行をほぼ固定長フレーズとして扱う前提
- 不規則な描画順の自動補正はしない
- `lineStrokeMappings` の品質は Gemini の判断に依存する
- 不正な group id や重複割り当てはサーバー側で補正する

今後、歌詞行ごとの正確な note 範囲を `SingingScore` 側に明示的に持たせると、より堅牢な同期ができます。
