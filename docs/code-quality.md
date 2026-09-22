# 依存監査と lint

## 実行方法

Node.js 20.19 以上の 20 系、22.13 以上の 22 系、または 24 以上を使用する（ESLint 10 の対応範囲）。この変更では Windows / Node.js 22.17.1 で確認した。

```powershell
npm.cmd ci
npm.cmd run audit
npm.cmd run lint
npm.cmd run type-check
npm.cmd test
npm.cmd run build
```

`audit` は開発依存を含む既知の脆弱性を検査し、low 以上があれば失敗する。監査結果は実行時点の npm advisory に依存し、安全性全体を保証するものではない。更新時は `npm audit fix --force` を使わず、互換性・型検査・自動テスト・ビルドを確認する。

## 2026-09-22 の依存更新

- 更新前の監査は 9 件（high 7 / moderate 1 / low 1）、本番依存のみは 0 件。
- Vite を 6.4.3、Wrangler を 4.131.0、対応する Miniflare を 5.20260910.0-alpha に更新。Vite 6 系を維持し、Miniflare の既存 alpha 系も維持した。
- Miniflare のテスト設定は Durable Object binding の `workerName` を更新後の `worker` に合わせた。本番の Worker binding 設定の変更ではない。
- Babel、PostCSS、Browserslist、nanoid などの間接依存を互換範囲で更新。Wrangler / Miniflare が使用する sharp は 0.35.4。
- 更新後の全依存監査は 0 件。アプリのランタイム直接依存と、既存の protobufjs / ws override は変更していない。
- ESLint 10、TypeScript parser、React Hooks plugin を開発依存として追加した。

## lint の対象と段階導入

保存・表示の回帰検証用にjsdom 26.1.0とfake-indexeddb 6.2.5を開発依存へ追加。jsdomは現行Node.js 22.17.1でも動く版を固定する。ブラウザ配信コードには含めない。

`eslint.config.mjs` は JS / MJS / CJS / TS / TSX のソース・設定・テストを対象とする。ビルド結果、node_modules、Wrangler の生成物、ローカル資料、録画データ、生成された Worker 型は除外する。

- ESLint の recommended と、React の `rules-of-hooks` / `exhaustive-deps` を使用する。整形や React Compiler 向けの全ルールは導入していない。
- TypeScript の未定義名は `type-check` に任せる。未使用宣言の整理は後続作業とし、`no-unused-vars` は無効。型情報を必要とする Promise 等の追加ルールも未導入。
- 空の catch は既存の best-effort 処理を考慮して許可。日本語の区切り用正規表現の全角空白は許可する。
- `services/debugBundleService.ts` と `vite.config.ts` だけは、ファイル名から制御文字を除く目的の正規表現を `no-control-regex` の例外にする。
- 既存の未解決指摘は [ESLint の Bulk Suppressions](https://eslint.org/docs/latest/use/suppressions) により `eslint-suppressions.json` に固定した。指摘を直した扱いにはしない。

初期基準は以下の 15 件。今回は無関係な挙動を変えず、個別の確認・修正時に減らしていく。

| 対象 | ルール | 件数 | 後続で確認する内容 |
| --- | --- | ---: | --- |
| App.tsx | no-unsafe-finally | 2 | 世代が変わった場合の finally 内 return と、例外・後片付けの関係 |
| App.tsx | react-hooks/exhaustive-deps | 2 | cleanup での ref 参照、実験用音声生成関数の依存 |
| components/KaraokeLyricsPanel.tsx | react-hooks/exhaustive-deps | 2 | 再描画用 tick と歌詞の依存 |
| components/PaintCanvas.tsx | react-hooks/exhaustive-deps | 5 | 描画・消去・undo / redo / 生成関数の依存 |
| services/debugBundleService.ts | no-useless-escape | 1 | 秘匿化正規表現内の不要なエスケープ |
| services/voicevoxHealthService.ts、services/voicevoxService.ts | preserve-caught-error | 2 | ラップする Error の cause 保持 |
| src/voicevoxBackend.ts | no-useless-assignment | 1 | URL 正規化時の不要な代入 |

抑制は「ファイル × ルール × 件数」単位であり、行の識別ではない。同じファイル内で既存違反が減って別の違反が増えると、件数が同じまま通る可能性がある。変更箇所は差分レビューでも確認し、通常作業で `--suppress-all` を実行して基準を増やさない。

修正後に未使用の抑制があると lint は失敗する。解決内容を確認してから `npm.cmd run lint -- --prune-suppressions` で不要分を削り、差分をレビューする。基準を含めた全指摘は次の読取専用コマンドで確認できる。

```powershell
node --input-type=module -e 'import { ESLint } from "eslint"; const linter = new ESLint({ applySuppressions: false }); const results = await linter.lintFiles(["."]); console.log((await linter.loadFormatter("stylish")).format(results));'
```

設定の参照元: [ESLint flat config](https://eslint.org/docs/latest/use/configure/configuration-files)、[TypeScript parser](https://typescript-eslint.io/packages/parser/)、[React Hooks lint](https://react.dev/reference/eslint-plugin-react-hooks)。
