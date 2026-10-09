# 審査説明に使える根拠と体験確認

この資料は、2026年10月9日の実装から作品の説明を組み立てるための対応表です。大会の公式審査項目・配点はこの資料では確認していません。「独創性」「実用性」などは説明の観点であり、公式基準を引用したものではありません。

公式情報の確認状況（2026年10月9日）：[第37回全国高等専門学校プログラミングコンテストの案内](https://www.procon.gr.jp/?p=79919)で創造性を重視する説明を確認しました。ただし、案内から参照する[本選実施要項](https://www.procon.gr.jp/uploads/download/BfCUFppgVAA)は確認時に404となり、本文を取得できていません。採点項目と配点は未確認です。下表は作品を説明する観点として使用してください。

## 説明と実装の対応

| 説明の観点 | コードから説明できること | 実装根拠 | 体験で確認する場所 |
| --- | --- | --- | --- |
| 作品の核 | 自分で描いた絵を入力に、日本語の歌詞と歌声を作る | [PaintCanvas](../../components/PaintCanvas.tsx)、[generateEkakiUta](../../services/geminiService.ts)、[synthesizeSingingVoice](../../services/voicevoxService.ts) | メーカー画面で絵を描き、生成して歌詞と音声を確認 |
| 独創性を説明する観点 | 完成画像に加え、描画の軌跡を作詞と再生に使う設計 | [groupStrokes](../../services/strokeGroupingService.ts)、[buildLegacyLyricsPrompt](../../services/lyricsPipeline.ts)、[DrawingPlaybackCanvas](../../components/DrawingPlaybackCanvas.tsx) | 複数の部分を順に描き、歌詞に合わせて描画が進む様子を確認 |
| 技術的な工夫 | 生成歌詞をそのまま読み上げるだけでなく、歌唱用かなを音符と長さへ変換する | [buildSingingScore](../../services/melodyService.ts)、[SingingScore型](../../types.ts) | 歌詞の発音と拍の流れを聞き、描画と対応しているか確認 |
| 体験の継続 | 生成の工程表示と完了処理、歌声失敗時の再生経路を用意する | [GenerationJourney](../../components/GenerationJourney.tsx)、[useGenerationCompletion](../../hooks/useGenerationCompletion.ts)、[createSilentPlaybackAudio](../../services/silentPlaybackService.ts)、[App.tsx](../../App.tsx) | 生成中の表示、別画面からの復帰、失敗時の案内を確認。無音の再生を歌声成功として扱わない |
| 実用性を説明する観点 | 保存した作品の再閲覧やギャラリー表示を用意する | [saveDebugHistoryRecord](../../services/debugHistoryDb.ts)、[demoRecordService](../../services/demoRecordService.ts)、[useGalleryRecords](../../gallery/useGalleryRecords.ts) | 保存して記録画面を開き、音声のある作品を`/gallery`で確認 |
| 利用者への説明 | 公開の作品保存と、生成に必要な通信を分けて扱う。新規クラウド長期保存は無効 | [appFeatures](../../config/appConfig.ts)、[EvaluationConsentModal](../../components/EvaluationConsentModal.tsx)、[Worker設定](../../wrangler.jsonc) | 保存確認の文言と、保存を選ばない場合の動作を確認 |
| 展示運用 | 公開のブラウザ保存とローカル展示のサーバー記録を使い分ける | [appFeatures](../../config/appConfig.ts)、[index.tsx](../../index.tsx)、[demoRecordFiles.ts](../../server/demoRecordFiles.ts) | 実際に展示で使う起動方法と保存先を確認 |

## 当日の短い実演

1. メーカー画面で、丸・耳・顔など、描く順序が見える簡単な絵を描く。
2. 生成を開始し、完成画像と軌跡を使って歌ができると説明する。通常設定では1候補を生成する。
3. 表示された歌詞を読み、音声と描画の同期を再生する。生成結果は毎回同一とは限らず、対象の認識や歌詞と線の対応が意図と異なる場合もある。
4. 保存した作品を記録画面で開く。音声がある場合は`/gallery`でも再生する。
5. 保存先が公開版では当該ブラウザ、ローカル展示版では展示サーバーであると説明する。

再生時は音声が聞こえること、歌詞が表示されること、線が進むことをそれぞれ確認してください。接続先の設定表示やバージョン確認だけでは、歌声合成と再生が成功した証拠にはなりません。

## 断定を避ける項目

「学習効果がある」「創造性が向上する」「既存製品より優れている」「世界初」「何人でも同時に使える」は、この実装調査だけでは裏付けられません。教育場面で使える可能性や、子どもが自分の絵を歌として楽しむことを狙った設計として説明し、効果測定や比較がある場合はその条件と結果を別に示してください。

保存した作品数や生成回数は、利用・保存の記録です。満足度や教育効果の証明へ置き換えないでください。ローカル記録や評価回答を紹介する場合は、公開可能な範囲を別途確認してください。

## 検証の記録を添える場合

[package.json](../../package.json)には歌詞、旋律、描画下書き、ブラウザ保存、ギャラリー、音声ジョブなどのテスト入口があります。テストファイルの存在だけで「全テスト合格」と説明せず、実行日・対象・結果を記録してください。

この資料作成ではコードと設定を照合し、Markdownの実装リンクを確認しています。公開サイトの新規生成、実音声再生、スマートフォン、弱回線、同時負荷、教育効果は新たに検証していません。審査向けに成功例を示す場合も、この未検証範囲を成功例と混同しないでください。

技術構成と実行環境の違いは[技術概要](technical-overview.md)、詳細な生成処理は[絵描き歌生成の流れ](../development/ekaki-uta-generation.md)を参照してください。
