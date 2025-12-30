# OekakiBattle

リアルタイムお絵描き当てバトル（お題当てゲーム）のMVPです。ログイン不要の匿名サインインで参加でき、ルーム単位で短時間の対戦ができます。

## できること（MVP）
- ルーム作成/入室/退室（部屋名・パスワード・ユーザー名）
- 参加者管理（最大20名）
- ラウンド進行（出題者の順番はランダム一巡）
- 描画キャンバス同期（Realtime broadcast）
- 回答/判定/スコアリング（最初の正解者 +1、出題者 +1）
- 結果表示（`v_room_scores`）

## 技術スタック
- Frontend: Next.js (TypeScript) / Netlify
- Backend: Supabase (PostgreSQL, Realtime, Edge Functions)
- Auth: 匿名サインイン（`supabase.auth.signInAnonymously()`）

## アーキテクチャ概要
- ルーム作成/入室/進行は Edge Functions → RPC で実行
- ゲーム状態は DB の `rooms/rounds/guesses` を Realtime 購読
- 描画ストロークは DB に保存せず Realtime チャンネルで配信

## セットアップ
### 必須環境変数
Frontend（Netlify/ローカル共通）
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Edge Functions
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

### ローカル開発
```bash
cd frontend
npm i
npm run dev
```

### DB初期化
Supabase プロジェクトに `supabase/sql/000_init_oekaki_battle.sql` を適用してください。

### Edge Functions
```bash
supabase functions deploy create-room
supabase functions deploy join-room
supabase functions deploy start-game
supabase functions deploy advance-round
supabase functions deploy end-game
```

## ドキュメント
- `docs/requirements/oekaki-mvp-requirements.md` 要件定義
- `docs/architecture.md` アーキテクチャ概要
- `docs/db/schema.md` DB設計（実装同期）
- `docs/api/edge-functions.md` Edge Functions仕様
- `docs/api/rpc.md` RPC仕様
- `docs/dev/README.md` 開発メモ/セットアップ補足

## ディレクトリ構成
- `frontend/` Next.js フロントエンド
- `supabase/` DBスキーマ/Edge Functions
- `docs/` 仕様・設計ドキュメント
