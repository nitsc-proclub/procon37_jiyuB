# 開発環境の起動

公開版を体験するだけなら[公開デモ](https://cho-ekaki-uta.nitsc-proclub.workers.dev/)を開いてください。以下は開発・ローカル展示向けです。

## 準備

Node.jsとnpm、Gemini APIキー、歌声に使うVOICEVOX Engineの接続先が必要です。Node.jsの対応範囲と検査方針は[品質確認](code-quality.md)を参照してください。

リポジトリのルートで依存関係をインストールします。

```powershell
npm.cmd ci
```

[.env.local.example](../../.env.local.example)を参考に`.env.local`を作り、Gemini APIキーとモデルを設定します。秘密値はGitへ追加しません。モデル候補や保存先などの設定は[ローカル運用](../operations/operations.md)を参照してください。

ローカル音声合成ではVOICEVOX Engineを既定の`http://127.0.0.1:50021`で起動します。遠隔の接続先を使う場合は[技術概要](../guide/technical-overview.md)と[運用案内](../operations/README.md)を確認します。

## 起動

```powershell
npm.cmd run dev
```

ブラウザで`http://localhost:3000`を開きます。Windowsの展示運用は[サーバー管理画面](../operations/local-server-manager.md)も利用できます。コマンドは移動先のdocsフォルダーではなくリポジトリルートで実行します。

## 変更時の検証

```powershell
npm.cmd run lint
npm.cmd run type-check
npm.cmd test
npm.cmd run test:gallery
npm.cmd run build
npm.cmd run check:gallery-public
```

ビルドは`dist`を更新します。既存の未コミット生成物を保持したい資料作業では、`npm.cmd run build -- --outDir <一時出力先>`を使い、`npm.cmd run check:gallery-public -- <一時出力先>`で同じ成果物を確認できます。`preview`はビルド済みアプリの確認用であり、Vite開発時と保存・公開フラグが異なります。

`main`へのpushは既存のWorkers Buildsによる自動デプロイにつながります。[公開運用](../operations/cloudflare-deployment.md)を確認し、資料編集だけの作業でCI設定変更や手動デプロイを追加しないでください。
