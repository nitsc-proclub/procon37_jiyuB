# Cloudflare Pages 公開確認版

この手順では、Gemini API、VOICEVOX、データ保存をまだ公開せず、画面と描画機能だけを確認できる状態でデプロイします。

## アプリの動作モード

| モード | 設定 | 用途 |
| --- | --- | --- |
| 完全版 | `VITE_APP_MODE=full` または未指定 | ローカル開発。既存機能をすべて表示します。 |
| 公開確認版 | `VITE_APP_MODE=deployment-preview` | 静的デプロイ。バックエンドが必要な機能を非表示・無効化します。 |

公開確認版では以下の動作になります。

- キャンバスへの描画、取り消し、やり直し、全消去を利用できます。
- AI生成とVOICEVOX生成のボタンは無効になり、APIリクエストを送信しません。
- データ保存スイッチ、実験画面、デモ記録画面を表示しません。
- 画面上部に公開確認版であることを表示します。

## ローカル確認

```bash
npm run build:deployment-preview
npm run preview
```

通常のローカル開発は従来どおりです。

```bash
npm run dev
```

## Cloudflare Pages のビルド設定

Cloudflare PagesでGitHubリポジトリを接続し、次を設定します。

| 項目 | 値 |
| --- | --- |
| Production branch | `main`（実際の運用ブランチに合わせる） |
| Build command | `npm run build:deployment-preview` |
| Build output directory | `dist` |
| Root directory | 未指定（リポジトリ直下） |

`build:deployment-preview`はリポジトリ内の`.env.deployment-preview`を読み込むため、Cloudflare側で`VITE_APP_MODE`を追加する必要はありません。明示的に設定する場合も値は`deployment-preview`にします。

## Cloudflare Access

デプロイ直後、URLを共有する前にCloudflare Accessを設定します。

1. One-time PINをIdentity Providerとして有効にします。
2. 許可するメールアドレスだけをAccess Policyに追加します。
3. 本番の`<project>.pages.dev`を保護します。
4. プレビュー用の`*.<project>.pages.dev`も保護します。
5. 未認証ブラウザではアプリが表示されないことを確認します。
6. 許可メールに届くPINでログインできることを確認します。

本番URLとプレビューURLは別々に保護状態を確認してください。リポジトリやREADMEには、実際のURL、許可メールアドレス、認証情報を記載しません。

## 秘密情報

`VITE_`で始まる環境変数はブラウザ向けJavaScriptに埋め込まれます。Gemini APIキーや認証用Secretには使用しないでください。

Gemini APIなどを将来有効化するときは、Cloudflare WorkersまたはPages Functionsなどのサーバー側でSecretを参照し、ブラウザへキーを返さない構成にします。

## デプロイ前チェック

```bash
npm run type-check
npm run build
npm run build:deployment-preview
```

- 完全版ビルドと公開確認版ビルドの両方が成功する
- 公開確認版で描画操作ができる
- 公開確認版でGemini、VOICEVOX、demo-recordsへの通信が発生しない
- Cloudflare Accessが本番URLとプレビューURLの両方に適用されている
