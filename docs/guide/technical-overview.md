# 技術構成と公開・展示の違い

2026年10月9日の作業ツリーのコードと設定に基づく説明です。配備済み環境の設定、音声の実再生、同時利用時の性能は、この資料の作成では確認していません。

## 絵から歌ができるまで

超えかき歌！は、完成した絵と描画の軌跡を使って日本語の絵描き歌を作り、歌声と描画を合わせて再生するブラウザアプリです。

| 工程 | 入力・処理・出力 | 実装の入口 |
| --- | --- | --- |
| 描く | 座標と時刻をストロークとして記録し、完成画像も取得する | [PaintCanvas.tsx](../../components/PaintCanvas.tsx)、[DrawingData型](../../types.ts) |
| 描画をまとめる | `groupStrokes`でストロークをグループにまとめる | [strokeGroupingService.ts](../../services/strokeGroupingService.ts) |
| 作詞する | `generateEkakiUta`から画像と描画情報をAPIへ送る。サーバー側でプロンプトを組み立て、歌詞と描画の対応を整える | [geminiService.ts](../../services/geminiService.ts)、[lyricsPipeline.ts](../../services/lyricsPipeline.ts)の`buildLegacyLyricsPrompt`、`normalizeLyricsResponse` |
| 音符にする | `buildSingingScore`で歌唱用かな、音高、音の長さからVOICEVOX用の譜面を作る | [melodyService.ts](../../services/melodyService.ts) |
| 歌声を作る | `synthesizeSingingVoice`でVOICEVOX Engineを呼び出す。遠隔経路にはジョブAPIもある | [voicevoxService.ts](../../services/voicevoxService.ts)、[voicevoxJobService.ts](../../services/voicevoxJobService.ts) |
| 合わせて再生する | 歌詞とストロークの対応、再生位置を使って描画を表示する | [DrawingPlaybackCanvas.tsx](../../components/DrawingPlaybackCanvas.tsx)、[playbackTiming.ts](../../utils/playbackTiming.ts) |
| 保存・再閲覧する | 実行環境に応じてブラウザ内または展示用サーバーの記録を読む | [debugHistoryDb.ts](../../services/debugHistoryDb.ts)、[demoRecordService.ts](../../services/demoRecordService.ts)、[useGalleryRecords.ts](../../gallery/useGalleryRecords.ts) |

生成全体の制御は[App.tsx](../../App.tsx)にあります。歌声生成に失敗した場合も、`createSilentPlaybackAudio`を使う再生経路があります。これは歌声合成が成功したことを意味しません。

## 採用技術と責任の分担

画面はReactとTypeScript、ビルドはViteです。Geminiを作詞に、VOICEVOX Engineを歌声合成に使います。依存関係は[package.json](../../package.json)で確認できます。

公開版は[Cloudflare Worker](../../src/worker.ts)がAPIと静的ファイル配信を受け持ちます。[wrangler.jsonc](../../wrangler.jsonc)には、VOICEVOX向けのQueues、D1、音声の一時保管用R2、VPCとCloud Runの接続設定があります。これらの設定ファイルが存在することだけでは、各サービスが現在稼働しているとは判断できません。

ローカル版のAPIは[Vite設定](../../vite.config.ts)から[Gemini middleware](../../server/geminiMiddleware.ts)や[VOICEVOX middleware](../../server/voicevoxMiddleware.ts)などにつながります。APIキーや認証情報の値を審査資料に記載する必要はありません。

## 公開版とローカル展示版

以下は[appFeatures](../../config/appConfig.ts)と公開Workerの設定に基づく違いです。「ローカル展示版」はVite開発サーバーで動く構成を指します。ビルド後のプレビューは別のフラグになるため、展示前に起動方法も確認してください。

| 観点 | 公開版 | ローカル展示版 |
| --- | --- | --- |
| 基本体験 | 描画、作詞、歌声生成、同期再生 | 描画、作詞、歌声生成、同期再生 |
| 作品の保存 | 同じブラウザ・同じ配信元のIndexedDB | ローカルのデモ記録APIとファイル |
| 記録画面 | ブラウザに保存した作品を表示 | 展示用サーバーに保存した記録を表示 |
| `/gallery` | 同じ配信元のブラウザ保存から読む | デモ記録APIから読む |
| 記録更新の通知 | ブラウザ内通知と定期再取得など | SSEによるサーバー通知も使用 |
| 歌声の接続先 | 利用者端末のローカルVOICEVOX、遠隔VOICEVOXの経路 | ローカルVOICEVOX、遠隔VOICEVOXの経路 |
| 保守用のZIP出力・生成集計 | 公開ビルドでは`debugExport`、`browserGenerationStats`を無効化 | 展示・保守用の機能を有効化 |

ブラウザ保存の上限は[debugHistoryDb.ts](../../services/debugHistoryDb.ts)で50件、[browserHistoryStorage.ts](../../services/browserHistoryStorage.ts)で100MiBです。別端末や別ブラウザへ自動共有する保存ではありません。ギャラリーには音声のある作品を表示します。

新規クラウド長期保存は`appFeatures.cloudSaving=false`、`CREATION_ARCHIVES_ENABLED=false`、`EVALUATION_CENTRAL_STORAGE_ENABLED=false`です。関連実装が残っていることと、現在利用者に提供している機能を区別してください。作詞・歌声生成には通信があり、遠隔音声には一時保管もあります。「ブラウザ内保存」を、生成も通信しないという説明に置き換えないでください。

## 現在の生成設定と説明上の注意

[generationConfig.ts](../../config/generationConfig.ts)の既定候補数と公開Workerの`LYRICS_CANDIDATE_COUNT`は1です。通常体験を常時A/B比較として説明しないでください。公開設定の`LYRICS_PIPELINE_MODE`は`legacy`です。解析と複数候補の実装があることを、その経路が公開版で常に使われているという説明にしないでください。

公開設定のBPMは125です。`buildSingingScore`にはモーラ、休符、拍位置、アクセント情報を扱う処理があります。品質の優位性や子どもへの学習効果は、実装の存在だけから断定できません。

詳しい実装解説は[絵描き歌生成](../development/ekaki-uta-generation.md)、[描画同期](../development/drawing-playback-sync.md)、[公開生成](public-generation-parity.md)を参照してください。古い資料と現在のコードが異なる場合は、日付と設定を確認して説明を更新してください。
