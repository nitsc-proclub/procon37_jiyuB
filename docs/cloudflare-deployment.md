# Cloudflare Workers 公開版

公開版は Cloudflare Worker Static Assets として `https://cho-ekaki-uta.nitsc-proclub.workers.dev/` へデプロイする。`main` のpushをWorkers Buildsが検出し、Viteの`dist`と`src/worker.ts`を同じWorkerへ反映する。

## 公開版の機能

- Gemini APIはWorkerの`GEMINI_API_KEY` Secretを使って歌詞・歌唱用かな・線対応を生成する。
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

WorkerのSettings → Variables and Secretsで`GEMINI_API_KEY`をSecretとして登録する。`VITE_`を付けたり、値をGitや`wrangler.jsonc`へ書いたりしない。

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
