# 🎨 お絵かき歌メーカー

ユーザーが自由に描いた絵をAI（Google Gemini）が分析し、日本の伝統的な「絵描き歌」を自動生成するクリエイティブなウェブアプリケーションです。

---

## 📋 目次
- [セットアップ](#セットアップ)
- [開発](#開発)
- [トラブルシューティング](#トラブルシューティング)
- [機能](#機能)
- [プロジェクト構成](#プロジェクト構成)
- [セキュリティ](#セキュリティ)

---

## 🚀 セットアップ

### 必要なもの
- **Node.js** v16 以上
- **npm** (Node.js に付属)
- **Google Gemini API キー** ([取得方法](https://ai.google.dev))

### インストール手順

1. **リポジトリをクローン**
   ```bash
   git clone https://github.com/your-username/ekaki-uta-maker.git
   cd ekaki-uta-maker
   ```

2. **依存パッケージをインストール**
   ```bash
   npm install
   ```

3. **API キーを設定**
   - `.env.local.example` をコピーして `.env.local` を作成
   ```bash
   cp .env.local.example .env.local
   ```
   - Gemini API キーを取得
   - `.env.local` ファイルを開き、`your_api_key_here` を実際のキーに置き換え
   
   > ⚠️ **重要**: `.env.local` は `.gitignore` で除外されているため、GitHubにアップロードされません。API キーは絶対に GitHub にコミットしないでください。

4. **開発サーバーを起動**
   ```bash
   npm run dev
   ```
   ブラウザで `http://localhost:3000` にアクセス

---

## 🛠️ 開発

### 使用可能なスクリプト

| コマンド | 説明 |
|--------|------|
| `npm run dev` | 開発サーバーを起動（ホットリロード対応） |
| `npm run build` | 本番用にアプリをビルド |
| `npm run preview` | ビルド結果をローカルで確認 |

### プロジェクト構成

```
.
├── App.tsx                 # メインアプリケーション
├── index.tsx               # React エントリーポイント
├── index.html              # HTML テンプレート
├── types.ts                # TypeScript 型定義
├── components/
│   └── PaintCanvas.tsx     # 描画キャンバスコンポーネント
├── services/
│   └── geminiService.ts    # Gemini 生成 API の呼び出し
├── server/
│   └── geminiMiddleware.ts # Gemini API キーをサーバー側で扱う middleware
├── vite.config.ts          # Vite 設定
├── tsconfig.json           # TypeScript 設定
├── .env.local.example      # 環境変数テンプレート
└── README.md               # このファイル
```

### 型チェック

```bash
# TypeScript の型チェックを実行
npx tsc --noEmit
```

---

## ⚠️ トラブルシューティング

### エラー: GEMINI_API_KEY が設定されていません

**原因**: `.env.local` ファイルが作成されていない、または API キーが設定されていない

**解決**:
```bash
# .env.local.example をコピー
cp .env.local.example .env.local
# .env.local を開き、GEMINI_API_KEY=your_api_key_here を設定
```

### エラー: ネットワーク接続に問題があります

**原因**: インターネット接続の問題または Gemini API の一時的な障害

**解決**:
1. インターネット接続を確認
2. しばらく待機してから再度お試しください
3. [Gemini API ステータスページ](https://status.ai.google.dev)を確認

### エラー: API の使用制限に達しました

**原因**: Gemini API の使用制限（Rate Limit）に達した

**解決**: しばらく待機してから再度お試しください

### ページが真っ白に表示される

**原因**:複数の原因が考えられます
1. ブラウザのコンソールを開いて（F12キー）、エラーメッセージを確認
2. キャッシュをクリア（Ctrl+Shift+Delete）してページをリロード
3. 開発サーバーを再起動（`npm run dev` を中断して再実行）

---

## ✨ 機能

- 🎨 **自由な描画** - マウス/タッチで思うまま描画（キャンバス拡大表示対応）
- 🎵 **AI 自動作曲** - Google Gemini が筆順と形から歌詞を生成
- 💾 **作品履歴** - ブラウザに自動保存・管理
- 🖨️ **印刷対応** - 生成した歌詞を印刷可能
- 📱 **レスポンシブ** - スマートフォン・タブレット対応

---

## 🔒 セキュリティ

### API キー管理

- `.env.local` ファイルは `.gitignore` に登録済み
- GitHub にアップロードする前に、必ず API キーを `.env.local` から削除
- `.env.local.example` にはプレースホルダーのみを保持
- Gemini API キーはブラウザ向け JS に埋め込まず、Vite middleware 側でのみ読み込みます

### 本番環境での注意

- 本番環境では、環境変数を安全に管理する仕組みを構築してください
- API キーは絶対にコード内にハードコードしないでください
- 静的ホスティングに配置する場合は、`/api/gemini/generate-ekaki-uta` 相当のサーバー API を別途用意してください

---

## 📦 デプロイ

### デプロイ方法

Netlify、Vercel、GitHub Pages など、静的ホスティングサービスにデプロイ可能です。
