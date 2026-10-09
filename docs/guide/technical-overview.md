# 技術構成と公開・展示の違い

絵の読み取りから歌詞、楽譜、歌声をつくり、描画と合わせて再生するまでの仕組みを説明します。

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

生成全体は[App.tsx](../../App.tsx)で制御します。歌声を生成できない場合は、`createSilentPlaybackAudio`で用意した無音の音声に合わせて描画を再生します。

## 採用技術と役割

画面はReactとTypeScript、ビルドはViteです。Geminiを作詞に、VOICEVOX Engineを歌声合成に使います。依存関係は[package.json](../../package.json)で確認できます。

公開版のAPIと静的ファイルの配信先は[Cloudflare Worker](../../src/worker.ts)です。[wrangler.jsonc](../../wrangler.jsonc)には、VOICEVOX向けのQueues、D1、音声の一時保管用R2、VPCとCloud Runの接続設定があります。接続先や実行枠は、この設定と各サービスの設定で管理します。

ローカル版のAPIは[Vite設定](../../vite.config.ts)から[Gemini middleware](../../server/geminiMiddleware.ts)や[VOICEVOX middleware](../../server/voicevoxMiddleware.ts)などにつながります。APIキーはサーバー側で扱います。

## 公開版とローカル展示版

機能の切り替えは[appFeatures](../../config/appConfig.ts)で定義しています。ローカル展示版はVite開発サーバーで動かす構成です。ビルド後のプレビューでは機能フラグと保存先が異なります。

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

新規クラウド長期保存は`appFeatures.cloudSaving=false`、`CREATION_ARCHIVES_ENABLED=false`、`EVALUATION_CENTRAL_STORAGE_ENABLED=false`です。作詞と歌声生成には外部サービスへの通信が必要です。遠隔で生成した音声は、受け渡しのために一時保管します。

## 生成設定

[generationConfig.ts](../../config/generationConfig.ts)の既定候補数と公開Workerの`LYRICS_CANDIDATE_COUNT`は1です。公開設定の`LYRICS_PIPELINE_MODE`は`legacy`で、画像と線の情報から1段階で作詞します。2段階の解析やA/B比較は、別の設定で有効にする機能です。

公開設定のBPMは125です。`buildSingingScore`にはモーラ、休符、拍位置、アクセント情報を扱う処理があります。歌唱用かなを読みの単位に分け、語の区切りや拍に合わせて音の長さを調整します。

詳しい実装解説は[絵描き歌生成](../development/ekaki-uta-generation.md)、[描画同期](../development/drawing-playback-sync.md)、[公開生成](public-generation-parity.md)を参照してください。
