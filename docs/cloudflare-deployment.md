# Cloudflare Workers 公開版

公開版は Cloudflare Worker Static Assets として `https://cho-ekaki-uta.nitsc-proclub.workers.dev/` へデプロイする。`main` のpushをWorkers Buildsが検出し、Viteの`dist`と`src/worker.ts`を同じWorkerへ反映する。

## 公開版の機能

- Gemini APIはWorkerの`GEMINI_API_KEY` Secretを使って歌詞・歌唱用かな・線対応を生成する。
- 歌詞生成の直前にTurnstileを検証し、成功・`generate-ekaki-uta` action・設定済みhostnameがそろったリクエストだけがGemini APIへ進む。トークンなし、失効、再利用、または不一致ではGemini APIを呼ばない。
- ブラウザを開いたPCのVOICEVOX Engineへ、固定loopback URLから任意で接続する。
- VOICEVOXが使える場合は歌声WAVを生成し、描画アニメーションと歌詞を同期再生する。
- Engine未起動、CORS未設定、ブラウザ権限拒否、合成失敗の場合も、楽譜長の無音WAVを時計としてアニメーションを再生する。
- demo-records、データ保存、生成計測、メロディ実験画面は公開版では無効のままにする。

## Cloudflare設定

| 項目 | 値 |
| --- | --- |
| Production branch | `main` |
| Build command | `npm run build:deployment-preview` |
| Deploy command | `npx wrangler deploy` |
| Root directory | リポジトリ直下 |

WorkerのSettings → Variables and Secretsで`GEMINI_API_KEY`と`TURNSTILE_SECRET`をSecretとして登録する。`VITE_`を付けたり、値をGitや`wrangler.jsonc`へ書いたりしない。

`TURNSTILE_EXPECTED_HOSTNAME`は同じ画面で通常の（非Secret）変数として、Turnstile Widgetに登録した公開hostnameを小文字で設定する（例: `cho-ekaki-uta.nitsc-proclub.workers.dev`）。未設定時はWorkerが安全側に倒れ、生成を`503`で拒否する。Hostリクエストヘッダーを代替値にしてはならない。

ブラウザへ渡す`VITE_TURNSTILE_SITE_KEY`は公開可能なSite keyであり、Workers Buildsのビルド環境変数として設定する。これはSecretではない。一方、`TURNSTILE_SECRET`を`VITE_`変数、Git、`wrangler.jsonc`、ブラウザbundleへ入れてはならない。

## Turnstileの作成と検証

1. Cloudflare DashboardのTurnstileでWidgetを作り、公開hostnameを登録する。フロントエンドはactionを`generate-ekaki-uta`として描画中に確認を先行実行し、生成時に取得済みトークンを送る。Viteの`npm run dev`でだけローカルmiddlewareを使うため確認を省略するが、ビルド済みアプリは`VITE_APP_MODE`に関係なくWorkerの検証を通る。
2. Workers Buildsのビルド変数へ`VITE_TURNSTILE_SITE_KEY`、WorkerのVariables and Secretsへ`TURNSTILE_SECRET`（Secret）と`TURNSTILE_EXPECTED_HOSTNAME`（通常の変数）を登録する。
3. トークンは5分間・一回限りなので、生成後または失効・失敗後はWidgetをresetして新しいトークンを取得する。
4. Cloudflareのテスト用キーでは、成功用Site key `1x00000000000000000000AA` と成功用Secret `1x0000000000000000000000000000000AA` を組み合わせて、Siteverify通信とトークン送信を確認する。テストキーの成功レスポンスはactionが`test`なので、このWorkerの本番用action検証では意図どおり拒否される。生成まで通す手動確認には、`generate-ekaki-uta` actionを設定した開発用Widgetを別途作成する。失敗・再利用の画面確認にはCloudflareのテスト用失敗/duplicate Secretを使用する。テストキーは本番Secretと混在させない。
5. 正常トークン、トークンなし、不正トークン、期限切れ/再利用、Siteverify到達不能の各ケースを確認し、失敗ケースでGemini APIが呼ばれないことをWorkersログとGemini使用量で確認する。

Turnstileは生成APIの乱用を減らすための確認であり、IPベースのWorkerレート制限は共有ネットワークの正当な利用者を巻き込むため、この構成には追加しない。Gemini側の予算・利用量アラートは別途設定する。

## ローカルVOICEVOXの準備

1. VOICEVOX Engineを起動する。
2. `http://127.0.0.1:50021/setting`を開く。
3. CORSの許可Originに次の値を正確に追加する。

   ```text
   https://cho-ekaki-uta.nitsc-proclub.workers.dev
   ```

4. `*`で全Originを許可せず、設定を保存してEngineを再起動する。
5. 公開版右上の「公開版・VOICEVOX」を開き、「VOICEVOXを再確認」を押す。
6. Chrome/Edgeにローカルネットワークアクセスの確認が出たら許可する。

既定では`http://127.0.0.1:50021`を先に、接続できなければ`http://localhost:50021`を確認する。右上の詳細からURLを変更でき、検証済みの値だけをブラウザへ保存する。指定できるのは`http`の`localhost`、`127.0.0.1`、`[::1]`、またはRFC 1918のプライベートIPv4アドレスのポート`50021`だけで、外部ホスト、パス、認証情報、query、fragmentは許可しない。LAN内の別端末から使う場合はVOICEVOX EngineのLAN待受、OSファイアウォール、CORS許可Origin、ブラウザのローカルネットワークアクセス許可も必要になる。接続失敗の原因はブラウザから区別できない場合があるため、Engine未起動・CORS・権限拒否などを断定せず、歌声なし再生へ切り替える。

現在の歌唱処理はVOICEVOX 0.25.1で次のstyle IDを使用する。

- 歌唱クエリ: `6000`
- フレーム合成: `3003`

これらがないEngineでは歌声合成だけが失敗し、歌詞とアニメーションは保持される。

## 確認コマンド

```bash
npm run type-check
npm run build:deployment-preview
npx wrangler deploy --dry-run
```

実ブラウザでは、VOICEVOX接続あり・なしの両方で、生成、再生、一時停止、シーク、最後までの描画と歌詞ハイライトを確認する。

## Cloudflare Access

アクセス制限はアプリではなくCloudflare Accessで設定する。One-time PINと許可メールアドレスのPolicyを本番URLへ適用し、認証情報をリポジトリへ書かない。

サイトをPublicへ戻してAccessを外す変更は、Turnstileのコード・Secret設定とは別作業である。TurnstileのPreview検証と本番Widget設定を完了してから、Cloudflare Dashboard上で影響範囲を確認して実施する。
