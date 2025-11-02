# Frontend (Next.js + Supabase)

## 必須環境変数
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Netlify のビルド環境変数に設定してください。

## ローカル開発
- Node 18+
- `cd frontend`
- `npm i`
- `npm run dev`

## 機能
- 匿名サインイン（初回アクセス時）
- トップページ: ルーム作成/入室（Supabase Edge Functions 呼び出し）
- ルームページ:
  - 参加者一覧（Realtime postgres_changes 購読）
  - ゲーム開始（ホストのみ → `start-game` Edge Function）
  - キャンバス（drawerのみ描画可能、broadcastで同期）
  - 回答投稿（`guesses` insert）

## 備考
- `rounds.started_at` の管理や次ラウンド/スキップは今後の拡張で Edge Function を追加可能です。
