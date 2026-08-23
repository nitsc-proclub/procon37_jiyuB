# 適応型・絵描き歌生成 第一段階 設計メモ

> 状態: Step 1〜4実装済み。Step 5はD1・Secret・Preview API検証まで完了、本番中央保存は既定OFF。Step 6は未着手。
> 確認日: 2026-08-23
> 対象: Gemini 3.7 Flash による描画理解と、Gemini 3.5 Flash 基礎モデルによる歌詞生成。SFT + Continuous Tuning は後続段階。
> 将来候補: 同じ実証データを利用した Gemini 3.5 Flash の RLFT

この文書は、実証実験で集める人の評価を使い、「絵描き歌らしい歌詞」を継続的に改善する第一段階の設計メモである。現在の実装と、これから追加する仕組みを区別し、開発者と生成 AI のどちらも後から判断の経緯を追えることを目的とする。

関連文書:

- [システム全体の概要](system-overview.md)
- [現在の絵描き歌生成の詳細](ekaki-uta-generation.md)
- [Cloudflare 公開版の運用](cloudflare-deployment.md)
- [デバッグ記録の保存計画](public-debug-record-storage-plan.md)

## 1. 結論

第一段階では、AIの仕事を次の2つに分ける。

1. **Gemini 3.7 Flash** が完成画像と描画順を読み、何がどのように描かれたかを構造化する。
2. **Gemini 3.5 Flash 基礎モデル** が、その構造化情報だけを受け取り、複数の絵描き歌候補を作る。SFT済みモデルへの置換はStep 6以降で行う。

利用者は候補から好みの歌詞を選び、必要なら理由や「描いたつもりのもの」を伝える。評価データはその場で無条件に学習へ流さず、同意・形式・品質を確認して蓄積する。一定数ごとに学習用データへ変換し、**Continuous Tuning** で既存の調整済みモデルを更新する。固定した評価用データで旧モデルより良いことを確認できた版だけを公開版へ昇格する。

画像認識そのものを独自に学習させる計画ではない。育てる中心は「同じ描画理解から、より絵描き歌らしく、子どもが歌いやすく、描画順に合う言葉を作る能力」である。

### 第一段階の評価データ保存方針

- 公開版で同意済みの評価データは、Cloudflare Workerで受け付け、Cloudflare D1へ保存する。
- ローカル起動時は既存どおり端末内のIndexedDBだけを使い、中央保存先へは送信しない。
- Cloudflare R2は、将来の承認済みJSONLのバックアップや、必要になった添付データの保管先として追加する。第一段階の評価原本の主保存先にはしない。
- SFTの実行時だけ、D1から人が承認した最小限のデータをJSONLとして書き出し、Google Cloud Storage（GCS）へ渡す。
- 画像・音声・氏名・自由記述は中央保存および学習JSONLの対象外を原則とする。

## 2. 現在の生成フロー（実装済み）

現在の公開版は Cloudflare Worker Static Assets 構成であり、Pages Functions ではない。ブラウザから `/api/gemini/generate-ekaki-uta` を呼び、`src/worker.ts` が Gemini API を代理呼び出しする。

```text
PaintCanvas
  └─ 完成PNG、raw strokes
       ↓
App.tsx / strokeGroupingService
  └─ strokeGroupsを追加
       ↓
services/geminiService.ts
       ↓ POST /api/gemini/generate-ekaki-uta
Cloudflare Worker: src/worker.ts
  └─ Turnstile検証
  └─ `LYRICS_PIPELINE_MODE=phase1` のときだけ二段生成
       ├─ 画像とstroke group要約 → Gemini 3.7 Flash
       └─ DrawingAnalysisのみ → Gemini 3.5 Flash（候補A/B）
  └─ `legacy` または二段生成失敗時は従来の単段生成へ切戻し
       ↓
LyricsResponse
  ├─ title
  ├─ lines / singingKanaLines
  ├─ identifiedObject
  └─ lineStrokeMappings
       ↓
melodyService → SingingScore
       ↓
ローカルVOICEVOX（利用できる場合）
       ↓
歌詞・歌声・描画同期再生
```

`legacy` 経路では、1回のGemini呼び出しが次をまとめて担当する。

- 絵に見えるものの推定
- 描画順・部品の理解
- 表示用歌詞と歌唱用かなの作成
- 歌詞行と stroke group の対応付け

既定値は `LYRICS_PIPELINE_MODE=legacy` で、従来どおり `gemini-3.6-flash` を第一候補とする。`phase1` では `GEMINI_VISION_MODEL=gemini-3.7-flash` と `LYRICS_BASE_MODEL=gemini-3.5-flash` を用いる。3.5は現時点で基礎モデルであり、調整済みモデルの認証・呼び出しは未実装である。二段生成の失敗時は単段の基準経路へ戻る。

## 3. 第一段階の新しい仕組み

```text
完成画像 + strokeGroups
       ↓
Gemini 3.7 Flash（描画理解）
       ↓
DrawingAnalysis JSON
  ・見える題材の候補（断定しすぎない）
  ・描画された部品、形、位置
  ・部品とstroke groupの対応
  ・描画順
       ↓
Gemini 3.5 Flash 基礎モデル（歌詞専門）
       ↓ 1回の呼び出しで候補A/Bを生成
LyricsCandidate[]
  ・表示用歌詞
  ・歌唱用かな
  ・歌詞行とstroke groupの対応
       ↓
利用者が候補を選択・評価
       ↓
同意済み評価データを蓄積
       ↓ 一定数ごとの確認済みバッチ
SFTデータ作成 → Continuous Tuning → 固定データで比較
       ↓ 改善確認後のみ
公開版の歌詞モデルを更新
```

### 二段構成にする理由

- 画像理解は最新の3.7に任せ、独自学習の対象を「作詞」に絞れる。
- 3.5側には画像を送らないため、学習データを小さく、確認しやすくできる。
- 認識と作詞の出力を別々に保存でき、失敗原因を説明しやすい。
- 候補A/Bは3.5への1回のリクエストでまとめて生成し、直列呼び出しの増加を最低限にする。
- 3.7の結果を一時表示するなど、待ち時間を体験の一部として扱える。

二段化するとGemini呼び出しは1回から2回になり、総生成時間が増える可能性がある。そのため、導入判断には品質だけでなく P50・P75・P95 の生成時間も使う。3.7の分析JSONは必要最小限にし、3.5へ画像を再送しない。

## 4. 技術をやさしく説明

### Gemini 3.7 Flash

画像と文章を一緒に理解できる現行のFlashモデルである。第一段階では「作詞家」ではなく「絵と描画手順を整理する観察役」として使う。画像、テキスト入力と Structured Outputs に対応しているため、次のAIへ渡す内容を決まったJSON形式にできる。

### SFT（教師ありファインチューニング）

「この入力には、この出力が良い」という手本を集め、AIに目的の振る舞いを覚えさせる方法である。

このプロジェクトでは、入力を `DrawingAnalysis`、正解例を人が選び必要に応じて直した歌詞とする。Googleは、まずプロンプトを十分に試し、質の高いラベル付きデータを用意してからチューニングすることを案内している。目安として100件以上が説明されているが、件数だけを目標にせず、内容の多様さと正しさを優先する。

### Continuous Tuning（継続チューニング）

一度SFTしたモデルを土台にして、新しい手本や追加の学習回数でさらに調整する機能である。毎回ゼロから作り直すのではなく、実証実験の新しいデータを確認済みバッチとして追加できる。

ここでいう「自動で成長」は、子どもがボタンを押すたびに即座にモデルを書き換える意味ではない。データ整形、重複・不適切内容の除外、評価、公開版への昇格判定をパイプライン化する意味である。誤操作や偏った少数意見による劣化を防ぐため、人の確認停止点を残す。

### チューニング済みモデル

元のGeminiに、このプロジェクト用の追加学習結果を組み合わせた専用モデルである。公開時はモデルのリソース名と版を固定し、いつ、どのデータで作った版かを記録する。

## 5. 追加するデータ形式

### 5.1 3.7の出力: `DrawingAnalysis`

例:

```json
{
  "schemaVersion": 1,
  "objectCandidates": [
    { "label": "りんご", "confidence": "high" },
    { "label": "なし", "confidence": "low" }
  ],
  "parts": [
    { "id": "p1", "shape": "大きな丸", "position": "中央", "strokeGroupIds": ["g1"] },
    { "id": "p2", "shape": "短い曲線", "position": "上", "strokeGroupIds": ["g2"] }
  ],
  "drawingOrder": ["p1", "p2"]
}
```

`confidence` は厳密な確率ではなく、断定を避けるための段階値とする。利用者による題材の訂正は保存するが、3.7の画像認識を独自学習させる教師データにはしない。歌詞候補の文脈や、認識失敗率の把握に使う。

### 5.2 3.5の出力: `LyricsCandidate[]`

候補ごとに次を持つ。

- `candidateId`
- `title`
- `lines`
- `singingKanaLines`
- `lineStrokeMappings`
- `identifiedObject`（3.7の候補を歌詞表示向けに整えたもの）

既存の `LyricsResponse` と楽譜・VOICEVOX処理を再利用できる形にし、利用者が選んだ候補だけを従来の再生処理へ渡す。

### 5.3 評価記録

Step 4の現行実装では、二候補が有効な`phase1`生成だけに表示順をランダム化した第一印象モーダルを表示し、最初の選択を固定する。`generationId`をキーに、候補、元のcandidate IDによる表示順、選択、`DrawingAnalysis`、モデル名を専用IndexedDBへ下書き保存する。保存は明示ホワイトリストで構築し、画像、音声、raw strokes、氏名・年齢入力、自由記述は受け取らず保存しない。一方で、AIが生成する候補歌詞や`DrawingAnalysis`のテキストには偶発的な氏名などが含まれ得るため、中央保存後も学習前の人手確認を必須とする。端末保存と中央保存はbest-effortで、失敗や拒否でも生成・再生を中断しない。認識訂正と詳細4項目評価は未実装である。

今回の現行UIは、候補ごとの試聴と好みの選択を分け、最初から両候補を同等に試聴できる設計である。これは次回の改善対象とし、評価目的を「歌詞だけを見た第一印象の比較」に合わせて変更する。

最低限、次を保存する。

| 分類 | 保存項目 |
| --- | --- |
| 追跡 | `generationId`、日時、実験回、アプリbuild ID、schema/prompt版 |
| モデル | 3.7モデル名、3.5基礎モデル名、調整済みモデルのリソース名・版 |
| 入力 | `DrawingAnalysis`、stroke group IDと要約 |
| 候補 | A/B両方の歌詞、かな、線対応、表示順 |
| 人の評価 | 選んだ候補、どちらも選ばない、任意の修正版、任意の理由 |
| 簡易指標 | 絵描き歌らしさ、描画順、子ども向け、歌いやすさ |
| 認識差 | 「描いたつもりのもの」（任意）、3.7の認識と違ったか |
| 同意 | 実証研究・学習への利用可否、保存範囲 |
| 性能 | 3.7、3.5、楽譜、VOICEVOX、全体の各所要時間と成否 |

学習対象は構造化された描画理解と採用済み歌詞を基本とし、画像・音声・氏名・自由記述は原則として学習JSONLへ含めない。年齢が分析に必要な場合も正確な生年月日ではなく年齢帯にする。子どものデータは、実証実験の説明と同意方法、保存期間、削除方法を先に決める。

## 6. 実証実験から学習まで

1. **基準版を固定する**  
   現行モデルと新しい未調整3.5の結果、生成時間、失敗率を保存する。比較用の描画を学習用と評価用に分け、同じ絵が両方へ入らないようにする。
2. **現地で候補A/Bを提示する**  
   左右・上下の表示順をランダム化し、好みの候補または「どちらも違う」を選べるようにする。題材の認識違いも任意で報告できるようにする。
3. **評価を保存する**  
   通信失敗でも生成結果を失わないよう、まず端末内に保持し、同意済みの最小データだけを中央へ送る。再送時の重複は `generationId` で防ぐ。
4. **学習候補を自動整形する**  
   選ばれた候補、または人が修正した最終版をSFT形式のJSONLへ変換する。未選択、不正形式、空欄、重複、個人情報を含む自由記述は除外する。
5. **人がバッチを承認する**  
   絵描き歌として意味が通るか、描画順に合うか、攻撃的・個人特定的な内容がないかを短時間で確認する。
6. **最初のSFTを実行する**  
   Gemini 3.5 Flashを基礎モデルにし、学習用と検証用のGCS上JSONL、リージョン、epoch、adapter size、learning rate multiplier、表示名を指定する。
7. **固定した評価用データで比較する**  
   同じ入力に基準版と調整版を出し、人がモデル名を知らない状態で比較する。学習に使った例だけの改善を成果にしない。
8. **合格版だけ公開する**  
   品質、JSON成功率、歌唱可能率、速度の基準を満たしたモデル版を設定に反映する。悪化時は直前版へ戻せるよう、版とデータセットIDを記録する。
9. **次回以降はContinuous Tuningを使う**  
   新しい確認済みバッチを追加し、同じ比較と昇格判定を繰り返す。

### 比較する指標

- 候補A/Bでの採用率と「どちらも違う」の割合
- 4項目（絵描き歌らしさ、描画順、子ども向け、歌いやすさ）の平均と分布
- `singingKanaLines` と `lineStrokeMappings` の形式成功率
- 楽譜・VOICEVOXまで完了した割合
- 題材の認識訂正率（3.7側の観察指標。3.5の主評価とは分ける）
- 生成時間 P50 / P75 / P95、API失敗率、再試行率

「数件うまく生成できた」だけで品質向上とは結論づけない。同じ評価用データ、同じ表示条件によるブラインド比較を成果の根拠にする。

## 7. 実装手順

### Step 1: 境界となる型とプロンプトを分離（実装済み）

- `types.ts` に `DrawingAnalysis`、`LyricsCandidate`、`EvaluationDraft` を追加する。
- 現在 `src/worker.ts` と `server/geminiMiddleware.ts` に重複している生成ロジックを、描画理解と作詞の2つに分ける。
- 3.7用のJSON Schemaと3.5用のJSON Schemaを別々に版管理する。
- 内部は二段でも、ブラウザからの生成APIは当面1つに保ち、Turnstileを1回だけ検証する。

### Step 2: 3.7描画理解を実装（実装済み）

- 完成画像と stroke group 要約を `gemini-3.7-flash` へ送る。
- `DrawingAnalysis` を検証し、不正JSON・空の部品・未知のgroup IDを拒否または安全に補正する。
- 認識候補は1つに断定せず、歌詞生成に必要な形・位置・順序を中心にする。

### Step 3: 3.5歌詞生成を実装（実装済み）

- `DrawingAnalysis` のみをGemini 3.5 Flash基礎モデルへ渡す。
- 1回の応答で候補A/Bを生成し、両方をスキーマ検証する。
- 片方だけ不正なら有効な候補を残し、両方失敗なら再試行または安全な基準モデルへ戻す。
- 選択後は既存の `melodyService`、VOICEVOX、描画同期をそのまま利用する。

### Step 4: A/B評価UIと端末内下書き（実装済み）

- 二候補の生成が完了した直後、通常の結果画面へ進む前に、同じDOMのレスポンシブモーダルでタイトルと全歌詞を表示する。
- 利用者は歌詞の第一印象だけで候補または「どちらも違う」を選ぶ。候補選択は一度だけ `firstImpressionSelection` として確定し、候補を後で切り替えても変わらない。「どちらも違う」は表示先頭の候補を通常画面へ進める。
- 表示順は生成ごとにランダム化するが、保存時は元の `candidateId` を保持する。
- 候補を切り替えると、候補に対応する歌詞・楽譜・音声・線対応をまとめて更新する。VOICEVOXが使えない・失敗した場合は無音WAVで従来のアニメーション再生を継続する。
- 通常結果画面では、もう一方を任意に確認できる小さな「もう一つも見る／聞く」ボタンだけを表示する。候補切替時は `activeCandidateId` と `alternativePreviewed` を更新する。
- 新規生成・クリア・編集・デモ/履歴表示・unmount時に候補キャッシュ、下書き対象の画面状態、Blob URLを安全に破棄する。

端末内の評価下書きは、上記の第一印象・active候補・もう一方の確認状態に加えて、中央保存同意状態（`not-asked` / `accepted` / `declined`）を明示ホワイトリストで保持する。Workerから有効なreceiptが返った生成だけに毎回同意UIを表示し、同意時だけ中央送信する。拒否しても生成・再生は継続する。

次回以降の対象: 認識訂正の入力、詳細4項目評価、Cloudflare手動接続と実地検証、SFT。自由記述は個人情報リスクを考慮し、要否を決めるまで収集しない。

#### 実装したStep 4改善方針

- 生成直後の歌詞第一印象モーダル、最初の選択の即時確定、任意のもう一方確認を実装済み。
- モーダルは縦画面・横画面で同じDOMを使い、歌詞フィールドをスクロール可能にして操作を抑制しない。
- 表示順のランダム化、元 `candidateId` の保持、「どちらも違う」、端末内下書きの個人情報境界を維持する。

### Step 4〜6の状態と次回着手順

| 範囲 | 状態 | 内容 |
| --- | --- | --- |
| Step 1〜3 | 実装済み | 二段生成、3.7描画理解、3.5候補A/B、旧経路への切戻し |
| Step 4 現行 | 実装済み | A/Bランダム表示、候補ごとの試聴、好み選択、「どちらも違う」、端末内評価下書き |
| Step 4 改善 | 実装済み | 生成直後の歌詞第一印象ポップアップ、最初の選択を即 preference 確定、任意のもう一方確認 |
| Step 5 | 基盤設定・API境界検証済み、本番OFF | 毎回同意UI、署名receipt、Worker評価API、D1 migration、冪等保存、承認・除外、approved-only JSONL。残りはstaging環境または実ブラウザの生成・同意・保存確認と本番有効化 |
| Step 6 | 未着手 | 承認済みJSONLのGCS連携、SFT、固定評価、モデル版比較・切替、Continuous Tuning |

Step 5のコード、D1 binding、Secret、ローカル・Preview・本番migration、Version PreviewでのAPI安全境界検証まで完了した。Version Previewが本番D1 bindingを使うことも実測し、中央保存ONのaliasはOFF版へ差し替えた。中央保存は既定OFFのままである。次は`docs/evaluation-storage-operations.md`に従い、Preview D1を`database_id`へ明示したstaging環境または管理下の実ブラウザで、横画面・スマホ縦画面・拒否・正常保存を確認してから本番有効化する。

### Step 5: 収集・書き出しを追加（基盤設定済み・本番OFF）

- **コード実装済み:** クライアントの`generationId`送信、毎回同意UI、payloadの厳格なwhitelist/group参照検証、Workerの署名receipt、`POST /api/evaluations`のsame-origin・`no-store`・256KiB制限、D1 migration、`generation_id` + `payload_hash`の冪等保存と409競合、承認済みレコードを上書きしない承認・除外CLI、approved-only JSONL export。
- **Cloudflare側で完了:** 本番・Preview D1作成、binding、全migration適用、`EVALUATION_RECEIPT_SECRET`登録、Version Previewでのsame-origin・`no-store`・payload検証・Secret認識。Version Previewは本番D1 bindingになるため、無効payloadだけで確認してOFF版へ差し替えた。
- **本番ON前の残件:** Turnstileを含む実生成からreceipt発行、同意拒否時の非送信、同意時の正常保存、横画面・スマホ縦画面を確認する。それまでは`EVALUATION_CENTRAL_STORAGE_ENABLED=false`を維持する。
- ローカル起動時は既存のIndexedDBだけを使い、中央送信はしない。公開版で同意を得た最小データだけをWorkerの評価API経由でD1へ保存する。画像、音声、raw strokes、氏名、年齢、自由記述は中央保存しない。
- 認識訂正と詳細4項目評価は、保存API接続後に端末内下書きから追加する。評価尺度、必須／任意、除外基準、承認者はユーザーの研究・運用判断が必要である。
- Cloudflare R2は、将来のJSONLバックアップや明示的に同意を得た添付データの保管が必要になった場合だけ追加する。R2を公開バケットにせず、評価データの主DBにはしない。
- 既存のIndexedDB/ZIP記録はデバッグ用として維持し、同意済み学習データと混ぜない。

### Step 6: SFT、評価、モデル切替（未着手）

- Google Cloudプロジェクト、課金、必要API、GCSバケット、実行サービスアカウント、リージョンを準備する。
- 最初のSFTはGoogle Cloudコンソールで手順を確認して実行し、同じ設定をスクリプト化する。
- 調整ジョブID、基礎モデル、データセット版、パラメーター、チェックポイント、評価結果を記録する。
- 公開モデルはGit管理の非秘密設定で版を固定し、資格情報はSecretに置く。
- Continuous Tuningは新しい承認済みバッチがたまった時だけ実行する。

### 変更・決定履歴

- **2026-08-22: Step 1〜3実装済み** — 3.7による描画理解、3.5による候補A/B生成、新旧経路の設定切替と旧経路へのフォールバックを確定した。
- **2026-08-22: Step 4現行実装済み** — A/B表示順ランダム化、候補ごとの試聴、好み選択、「どちらも違う」、端末内の最小限の評価下書きを追加した。中央送信・同意・D1・SFTは対象外とした。
- **2026-08-22: Step 4改善方針を決定** — 歌詞だけの第一印象で最初に試す候補を選び、その選択を即時 preference として確定する。もう一方は小さな確認ボタンから任意に見る／聞く方式へ変更する。
- **2026-08-23: Step 4改善を実装** — 生成直後の第一印象モーダル、候補選択の固定、表示先頭へ進む「どちらも違う」、通常結果の小さな代替候補ボタン、端末内下書き項目を追加した。中央保存はreceipt・機能フラグがそろった場合だけ同意UIを表示できる準備に留め、送信は行わない。
- **2026-08-23: Step 5のコード実装を完了** — 毎回同意UI、評価payloadの厳格検証、署名receipt/fingerprint、Worker評価route、D1 migrationと冪等保存、承認・除外、approved-only exportを追加した。CloudflareのD1作成・binding・secret・migration適用・本番有効化は未実施である。
- **2026-08-23: Cloudflare基盤を設定** — 本番・Preview D1、binding、migration、Worker Secret、生成型を設定し、Version Previewで評価APIの安全境界を確認した。本番中央保存は実ブラウザ確認までOFFを維持する。
- **2026-08-22: 将来の保存同意方針を決定** — Step 5の中央保存時は毎回確認ポップアップを出し、横画面・スマホ縦画面の双方で利用できるようにする。拒否しても生成・再生は可能とする。

## 8. 設定項目案

固定値は `wrangler.jsonc` などGit管理の設定へ置き、秘密値はCloudflare Worker SecretまたはGoogle Cloud側のSecretとして管理する。

| 設定 | 目的 | 秘密か |
| --- | --- | --- |
| `GEMINI_VISION_MODEL=gemini-3.7-flash` | 描画理解モデルを固定 | いいえ |
| `LYRICS_BASE_MODEL=gemini-3.5-flash` | 学習の基礎モデルを記録 | いいえ |
| `LYRICS_TUNED_MODEL_RESOURCE` | 公開する調整済みモデル名・版 | いいえ |
| `LYRICS_PIPELINE_MODE=phase1` | 新旧経路を切替・切戻し | いいえ |
| `LYRICS_CANDIDATE_COUNT=2` | A/B候補数 | いいえ |
| `DRAWING_ANALYSIS_SCHEMA_VERSION` | 3.7出力形式の版 | いいえ |
| `LYRICS_PROMPT_VERSION` | 3.5入力指示の版 | いいえ |
| `EXPERIMENT_ROUND_ID` | 実証実験回 | いいえ |
| `EVALUATION_STORAGE_MODE=d1` | 公開版の評価保存先をD1に固定 | いいえ |
| `GOOGLE_CLOUD_PROJECT` / `LOCATION` | チューニングと推論先 | いいえ |
| GCSの学習・検証URI | 使用データセット版 | 原則いいえ |
| Google Cloud認証情報 | 調整済みモデル呼び出し | **はい** |
| 評価保存先の認証情報 | 同意済み評価の保存 | **はい** |

現在のWorkerはGemini Developer APIキーで呼び出している一方、SFTとContinuous TuningはGoogle Cloud側の機能である。実装時には調整済みモデルの認証経路が追加で必要になる。ブラウザへ認証情報を渡さず、WorkerまたはGoogle Cloud上の小さな推論APIから呼ぶ。1週間の試作では、Google Cloud上の実行サービスアカウントを使える推論APIを置く方が長期サービスアカウント鍵の管理を減らしやすい。方式は実装着手時に最小構成と遅延を測って確定する。

評価保存用のD1 bindingは `wrangler.jsonc` で管理し、D1の認証情報をブラウザへ渡さない。D1を日本国内へ固定する必要がある場合は、実装前に保存先を東京リージョンのFirestoreへ見直す。Cloudflare D1の配置指定だけでは日本固定を保証しないためである。

## 9. 最低限の検証チェックポイント

- 3.7の出力に存在しない stroke group ID が混入しない。
- 3.5へ画像や不要な個人情報を渡していない。
- A/Bの表示順がランダムで、保存時に元のcandidate IDを保持する。
- 連打・再送でも同じ評価を重複保存しない。
- 同意しない場合も作品生成と再生は利用できる。
- 評価保存が失敗しても歌詞・楽譜・再生結果を失わない。
- 新旧経路のJSON成功率、生成時間、VOICEVOX到達率を比較する。
- 調整済みモデルが失敗した時に、直前版または基準版へ切り戻せる。
- 学習データと固定評価データに同一生成・同一参加者由来の近い重複がない。
- `npm run type-check`、`npm run build`、`git diff --check` と実ブラウザ確認を行う。

## 10. 高専プロコンで示せる価値

### 独自性

- Googleのモデルをそのまま1回呼ぶだけではなく、画像理解と絵描き歌作詞を役割分担した独自パイプラインである。
- 一般的な画像認識の競争ではなく、「描画順を言葉と歌へ変換する」という未整備な課題に焦点を当てている。
- 子どもの選択を、絵描き歌らしさという人にしか評価しにくい品質へ結び付ける。

### 技術性

- 画像・ストロークから構造化された中間表現を作り、専門作詞モデルへ接続する。
- SFT、Continuous Tuning、モデル版管理、評価用データ分離、ロールバックを一つの改善サイクルとして実装する。
- 品質だけでなく、JSON妥当性、歌唱可能性、遅延、失敗率まで計測する。

### 実証性

- 現地で複数回、実際の子どもの描画と候補選択を集める。
- 調整前後を同じ評価条件でブラインド比較し、採用率や評価分布で示す。
- 成功例だけでなく、認識訂正、「どちらも違う」、失敗率、生成時間も報告する。
- どの実験データからどのモデル版が作られたかを追跡できる。

発表では「AIが勝手に正解になった」と表現せず、**人の評価を安全にデータ化し、学習・検証・採用までを自分たちで設計した**ことを中心にする。これが、既存サービスの単純利用との差になる。

## 11. 第二段階の可能性: Gemini 3.5 RLFT

第一段階が動き、十分な評価データと安定した評価方法が得られた場合は、同じ `DrawingAnalysis`、候補選択、修正版、4項目評価を使って **RLFT（Reinforcement Learning Fine-Tuning）** を検討する。

RLFTは、AIが複数の回答を試し、独自の報酬関数で高得点の回答が出やすくなるよう調整する方法である。歌詞のように正解が一つではなく、人の好みが重要な課題と相性がよい。一方、2026-08-22時点ではGoogle公式資料上 **Pre-GA** であり、機密データを使わず限定的な試験・評価に用いる条件が明記されている。したがって第一段階の本番経路には入れず、SFT + Continuous Tuningのデータと評価器が整った後の比較実験とする。

報酬候補は、描画順の整合、全stroke groupの利用、歌唱用かなの妥当性、子ども向け表現、人による絵描き歌らしさ評価である。ただし、機械判定しやすい項目だけを強くすると不自然な歌詞へ偏るため、人の評価との相関を確認してから重みを決める。

## 12. Google公式情報源

対応状況は変わるため、実装開始時とチューニング実行時に再確認する。

- [Gemini 3.7 Flash モデル仕様](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash) — 画像入力、Structured Outputs、モデルID
- [Gemini 3.5 Flash（Google Cloud）](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash) — SFT、Continuous Tuning、チェックポイントの対応
- [Geminiモデルのチューニング概要](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tuning) — SFTの考え方、データ品質、対応モデル
- [SFTの実行手順](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tuning/supervised-tuning/use) — JSONL/GCS、学習・検証データ、設定項目、実行方法
- [Continuous Tuningの手順](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tuning/continuous-tuning) — 調整済みモデルやチェックポイントへ新しいデータを追加する方法
- [Gemini RLFTの概要](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tuning/reinforcement-tuning) — 報酬関数、反復学習、対応モデル、Pre-GA上の注意

公式ページの最終更新日は2026-08-21（Gemini 3.7 FlashのGemini APIモデルページは2026-08-13）である。本書のモデル対応表現は2026-08-22に確認した内容であり、将来の提供終了・名称変更・利用条件変更に備えてモデル名と版を設定で固定する。
