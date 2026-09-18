# Windows のローカル管理画面

通常版を `main` ブランチで使うための管理画面です。合奏用の起動・ビルド処理は含みません。

## 起動方法

- `超えかき歌_サーバー管理セット/超えかき歌！_管理.bat` をダブルクリックします。
- ルートの `manage-local.cmd` からも同じ画面を開けます。
- 既存のデスクトップ・タスクバーの管理ショートカットも、従来と同じ `cho_ekakiuta_manager.ps1` を呼び出すため、そのまま使用できます。

管理画面で `[1]` を選ぶと通常版を起動し、`http://localhost:3000` を開きます。既に起動している場合はブラウザーを開きます。

| 操作 | 内容 |
| --- | --- |
| `1` | 起動してブラウザーを開く |
| `2` | サーバーを停止する |
| `3` | サーバーを再起動してブラウザーを開く |
| `4` | ブラウザーを開く。停止中なら起動する |
| `5` | 起動ログ・エラーログを開く |
| `6` | プロジェクトフォルダーを開く |
| `8` | デスクトップ・スタートメニューのショートカットを作成・修復する |
| `9` | 状態を更新する |
| `0` | 管理画面を閉じる。サーバーは継続する |

サーバーはバックグラウンドで起動します。終了するときは `[2]` を選びます。

## ショートカット

管理画面の `[8]` または次のコマンドで設定できます。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-local-shortcuts.ps1
```

デスクトップに既存の `超えかき歌！_管理.bat - ショートカット` があれば更新し、なければ `超えかき歌！ サーバー管理` を作成します。スタートメニューにも同名の管理ショートカットを作成します。アイコンはプロジェクトの `public/favicon.ico` を使用します。

同名の既存タスクバーショートカットは参照先を更新します。新しいPCでは、作成した管理ショートカットの右クリックメニューからタスクバーにピン留めしてください。必要に応じて「その他のオプションを確認」を開きます。プロジェクトを移動した場合は、移動先のバッチから `[8]` を実行してください。

## 前提とエラー

- Node.js と npm、および `npm.cmd ci` でインストールした依存パッケージが必要です。
- 歌詞・音声生成の設定は従来どおり `.env.local` と VOICEVOX Engine を使用します。管理画面は Vite サーバーを管理します。
- ログは `logs/local-server/normal.log` と `normal.error.log` に保存します。
- ポート3000が別のプログラムに使われている場合は、そのプログラムを停止せずエラーを表示します。

## ローカル版でクラウドの歌声を使う

Vite のローカル版でも、歌声生成サーバーから Cloudflare VPC / Google Cloud Run を選択できます。

接続経路は `ブラウザー → ローカルVite API → 認証付きCloudflare Worker → 選択したVOICEVOX` です。ローカルVOICEVOXの合成・アクセント解析は従来どおり `/voicevox` 経由です。

`.env.local` に次のサーバー専用設定を追加し、管理画面から再起動してください。

```dotenv
VOICEVOX_REMOTE_API_URL=https://cho-ekaki-uta.nitsc-proclub.workers.dev
VOICEVOX_LOCAL_ACCESS_TOKEN=<32バイトの暗号学的乱数をbase64url化した43文字>
```

同じトークンを `npx.cmd wrangler secret put VOICEVOX_LOCAL_ACCESS_TOKEN` で公開Workerにも登録します。秘密の値はコマンド引数に書かず、標準入力で渡してください。`.env.local` はGit管理外です。トークンに `VITE_` を付けたり、ブラウザーの設定・ログ・公開ファイルに記録したりしないでください。変更時はWorkerとローカルを同時に更新します。

ローカルの歌詞生成は公開版の音声チケットを発行しないため、ローカルViteがサーバー認証を付けて専用の `/api/voicevox/local/*` に中継します。この経路もスコアとサイズを検証します。公開版の `/api/voicevox/synthesize` は引き続き一度限りの音声チケットを必須とします。

「バージョンを確認」は、ローカル版ではVPC・Cloud Runそれぞれの実Engineへ問い合わせます。Cloud Runの初回起動で待つ場合があります。公開版のCloud Run確認は起動を伴わない設定確認のままで、画面には「設定確認済み」「接続・バージョンは未確認」と表示します。HTML、未設定、取得失敗を「接続済み」とは表示しません。

設定がない・認証が一致しない場合は、確認または歌声生成時に設定エラーを表示します。ローカルVOICEVOXを使う場合、このクラウド設定は不要です。

回帰確認: `npm.cmd run test:voicevox-local`。HTTP中継、秘密情報を返さないこと、別サイトからの拒否、公開チケットの維持、バージョン確認の誤判定防止を検証します。

## 管理処理の補足

- `.dev-server.pid` だけを根拠にプロセスを停止しません。待受ポートと実行中の Node.js のスクリプトパスを確認します。
- バッチ起動時・ショートカットからの起動時とも、開始に失敗した場合はメッセージを表示して入力を待ちます。コマンドとして実行する場合の終了コードは失敗時 `1` です。
- バッチ、入口のPowerShell、管理処理はすべてGit管理対象です。Windows PowerShell 5.1向けに、日本語を含む `.ps1` は UTF-8 BOM付きで保存します。

## コマンドからの操作と確認

```powershell
.\manage-local.cmd -Action Status
.\manage-local.cmd -Action Start -NoBrowser
.\manage-local.cmd -Action Restart -NoBrowser
.\manage-local.cmd -Action Stop
```

`-NormalPort` でポートを変更できます。停止・再起動・状態確認にも同じポートを指定します。3000以外のポートではログ・PIDファイルを `logs/local-server/normal-<ポート番号>.*` に分けます。自動実行でエラー時の入力待ちを省略する場合は、環境変数 `EKAKI_MANAGER_NO_PAUSE=1` を指定します。

Windows の回帰確認は以下で実行します。隔離した一時フォルダーと空きポートで、起動・再起動・停止、別プロセスの保護、呼び出し先欠落時の終了コードを確認します。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\manage-local-servers.test.ps1
```
