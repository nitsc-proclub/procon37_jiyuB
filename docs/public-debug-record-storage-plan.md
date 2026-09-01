# 公開版デバッグ記録・共有機能 実装計画

> 2026-08-31追記: 以下は2026-08-09時点のローカル履歴/ZIP計画。現在Workerは歌声中継と同意済み評価のD1保存も担当する。作品素材の長期クラウド保管については[保存拡張メモ](creation-archive-plan.md)が最新方針であり、旧同意を使った画像・音声の自動収集はしない。以下の647件の容量値は当時の記録として残す（今回の659件集計は新メモ参照）。

## 目的

複数人がCloudflare公開版で絵描き歌生成を試し、問題が起きた生成結果を相互に報告・再確認できるようにする。

保存対象は、完成画像だけでなく、アニメーション再現に必要なストローク、ストロークグループ、歌詞との対応、歌詞・かな、楽譜、生成結果・失敗段階を含む。VOICEVOXで実際の歌声を生成できた場合は、その音声も任意で含める。

## 結論

次の2機能を両方実装する。

1. **1件ごとのデバッグ用ZIPダウンロード**
   - 他の利用者へ渡すための標準形式。
   - 最初に実装する。
2. **IndexedDBによるブラウザ内履歴**
   - 生成結果の取り逃し防止、再表示、再ダウンロードに使う。
   - 利用者が同意した場合だけ自動保存する。

`localStorage`は画像・ストローク・音声を扱うには容量が小さいため使用しない。公開版に既存の`/api/demo-records`をそのまま公開することもしない。現在のCloudflare WorkerはGemini APIだけを担当し、記録は利用者のブラウザ内とダウンロードファイル内で完結させる。

## 現在の保存データとの対応

ローカル版は、1件ごとに次を`demo-records/`へ保存している。

- `input.png`
- `metadata.json`
  - 開始・完了日時
  - 成功・失敗とエラー
  - Geminiモデル名
  - 歌詞、かな、認識した題材、歌詞とストロークの対応
  - 生ストローク、ストロークグループ、キャンバスサイズ、線幅
  - VOICEVOXへ送った楽譜
- `voice.wav`（現行実装では実歌声だけでなく、音声なし再生用の無音WAVを含む場合がある）

既存647件の実測では、1件平均は約0.82MB、最大は約1.37MBで、平均のうち約0.71MBが音声だった。したがって、構造化データと画像は履歴保存に向くが、音声を無制限に自動保存してはいけない。

## デバッグZIP形式

```text
cho-ekaki-uta-debug-20260808-123456.zip
├─ manifest.json
├─ input.png
├─ voice.wav        # 実歌声がある場合だけ
└─ README.txt       # 内容と共有時の注意
```

`manifest.json`の基本構造は次のとおりとする。

```json
{
  "format": "cho-ekaki-uta-debug-bundle",
  "schemaVersion": 1,
  "recordId": "uuid",
  "createdAt": "ISO-8601",
  "outcome": {
    "status": "success",
    "failedStage": null,
    "error": null
  },
  "app": {
    "buildId": "git-sha-or-build-id",
    "mode": "deployment-preview",
    "origin": "https://cho-ekaki-uta.nitsc-proclub.workers.dev"
  },
  "generation": {
    "geminiModel": "model-name",
    "durationsMs": {},
    "playbackKind": "voice"
  },
  "drawing": {
    "image": { "path": "input.png", "mimeType": "image/png" },
    "strokes": [],
    "strokeGroups": [],
    "canvasSize": {},
    "lineWidth": 0
  },
  "lyrics": {},
  "singingScore": {},
  "audio": {
    "path": "voice.wav",
    "mimeType": "audio/wav"
  }
}
```

### 保存・共有しない情報

- Gemini APIキー
- Cloudflare AccessのCookie、認証ヘッダー、メールアドレス
- VOICEVOXの接続URLそのもの（共有データでは`loopback`・接続可否程度にする）
- 参加者年齢など、デバッグに不要な個人情報
- 音声なしアニメーション用に生成した無音WAV

共有前に、出力される診断情報を確認できる画面を用意する。エラー文字列は長さを制限し、秘密情報や画像データが混ざらないよう正規化する。

## ブラウザ内履歴

SingLinkと同様にIndexedDBへBlobと構造化データを保存する。

- DB案: `cho-ekaki-uta-debug-history`
- Store案: `records`（key: `recordId`、index: `createdAt`）
- 保存内容: manifest相当データ、入力画像Blob、任意の実歌声Blob
- 表示機能: 一覧、詳細、アニメーション再生、歌声再生、ZIP再出力、個別削除、全削除
- 初期上限案: 50件または100MB
- 保存前に`navigator.storage.estimate()`で使用量を確認する
- 上限時は自動削除せず、「古い履歴を削除」または「今回だけZIPを保存」を選んでもらう
- Blobのobject URLは表示時だけ作り、画面終了時に必ず破棄する

IndexedDB保存失敗は生成失敗として扱わない。容量不足やプライベートブラウズ等では、生成結果を残したまま警告し、ZIPダウンロードを案内する。

## 段階的な実装

実装状況（2026-08-09）:

- Goal 1: 完了
- Goal 2: 完了
- Goal 3: 完了
- Goal 4: 現時点では実装しない（必要性の確認まで保留）

### Goal 1: 共通記録形式と1件ZIPダウンロード

最初の実用ゴール。結果画面と失敗画面に「デバッグ用ファイルを保存」を追加する。

- `DebugBundleManifest`と`schemaVersion`を定義
- ビルド時に`git rev-parse HEAD`から公開可能なbuild IDを注入し、取得不能時は`unknown`とする。非Secretの明示的なbuild IDで上書きできるようにする
- 成功、Gemini失敗、VOICEVOX失敗、音声なし成功を記録へ変換
- `manifest.json + input.png + optional voice.wav`をZIP化
- 共有前プレビューと任意の「問題メモ」を追加
- ZIPファイル名に日時と短いrecord IDを入れる
- 既存ローカル保存、Gemini、VOICEVOXの処理は変更しない

受入条件:

- 公開版で成功・途中失敗のどちらもZIP出力できる
- ZIPだけで画像、ストローク、歌詞、楽譜、失敗段階を確認できる
- 実歌声があるときだけ`voice.wav`を含む
- `manifest.json`のbuild IDから、報告対象のコード版を特定できる。取得不能時は`unknown`と明示される
- APIキー、認証情報、年齢を含まない

### Goal 2: IndexedDB履歴

- 初回に「このブラウザへデバッグ履歴を保存する」同意を取る
- 同意後は成功・失敗を自動保存
- 履歴一覧、詳細、再生、ZIP再出力、削除を追加
- 保存件数・推定使用量を表示
- 保存失敗を非致命の警告として扱う

受入条件:

- ページ再読み込み後も履歴を開ける
- VOICEVOXなしの記録もアニメーション再生できる
- 容量不足でも現在の生成結果を失わない

### Goal 3: ZIPインポート・閲覧

- ZIPをドラッグ＆ドロップまたはファイル選択で読み込む
- ネットワークを呼ばず、絵、ストロークアニメーション、歌詞、楽譜、音声、失敗情報を表示
- 必要ならブラウザ履歴へ取り込む
- `schemaVersion`の移行処理を用意
- ファイル数、圧縮前後の容量、ファイルパス、MIME型を検証
- 壊れたZIPや将来バージョンは安全に拒否または読み取り専用表示

実装メモ:

- 現在はアプリが出力する非圧縮ZIPと`schemaVersion: 1`だけを受け付ける
- 未対応の圧縮方式、壊れたZIP、不明なファイル、将来のschemaVersionは履歴を変更せず拒否する
- 新しいschemaVersionを追加するときに、旧versionからの移行処理を同時に追加する

### Goal 4: バグ報告導線

現時点では実装しない。まずはブラウザ履歴、メーカーでの再生、ZIP共有を使った試用を行い、報告作成を手作業で補えないことが確認できた場合に再開する。

- 「期待した結果」「実際の結果」「再現手順」「バンドルID」を含む報告テンプレートをコピー可能にする
- ZIPをIssue、チャット、共有ストレージへ添付する運用手順を文書化
- 必要性が確認できた後に限り、Cloudflare R2/D1への中央収集を別計画として検討する

## 主な変更候補

- `types.ts`
  - デバッグ記録・schemaVersionの型
- 新規 `services/debugBundleService.ts`
  - manifest作成、画像Data URIからBlobへの変換、ZIP出力、ZIP検証
- 新規 `services/debugHistoryDb.ts`
  - IndexedDBの保存、一覧、取得、削除、容量管理
- `App.tsx`
  - 生成途中の記録候補保持、結果・失敗画面の保存操作、履歴画面への導線
- 新規コンポーネント候補
  - `DebugExportDialog.tsx`
  - `DebugHistoryView.tsx`
  - `DebugImportDialog.tsx`
- `config/appConfig.ts`
  - 公開版の`demoRecords`とは分離した`debugRecords` feature

## テスト方針

- 純粋関数: manifest生成、秘密情報除外、schema移行、ファイル名、無音WAV除外
- IndexedDB: 保存、再取得、順序、削除、上限、QuotaExceeded
- ZIP: 成功・失敗・音声あり・なし、破損、zip bomb相当、未知version
- UI: 同意あり・なし、保存失敗、共有前確認、再ダウンロード
- 実ブラウザ: 公開Chrome/Edgeで生成、再読み込み、別ブラウザへのZIP受け渡し
- 回帰: ローカル`demo-records`、Gemini生成、VOICEVOX歌声、音声なしアニメーションを維持

## 今回は行わないこと

- Cloudflareへの作品・画像・音声の自動アップロード
- 複数人で同じIndexedDBを共有すること
- 公開版で既存のローカル`/api/demo-records`を有効化すること
- 共有URLだけで記録を開ける機能

中央収集が必要になった場合は、保存期限、削除権限、Accessユーザーとの対応、R2/D1のコスト、個人情報同意を含む別設計が必要になる。

既存`demo-records`を将来インポートする場合、`voice.wav`というファイル名だけで実歌声と判定してはいけない。新形式では生成時の`playbackKind === "voice"`を根拠に実歌声だけを収録し、判定情報を持たない既存音声は「実歌声または無音fallback」として扱う。
> 2026-09-01: 公開版の新規作品は、明示同意時のみ評価・絵・線・A/B歌声を非公開クラウドへ365日保存する方式へ移行した。詳細は `creation-archive-plan.md`。既存データを遡って収集しない。
