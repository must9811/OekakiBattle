# 開発メモ / セットアップ

## 前提
- Supabase プロジェクト作成済
- 匿名サインイン（Anonymous Sign-in）が有効
- Netlify で Next.js をデプロイ（フロントから Supabase を利用）

## 環境変数（Edge Functions）
- SUPABASE_URL
- SUPABASE_ANON_KEY

## DB 反映手順
1. SQL を順番に適用
   - supabase/sql/001_schema.sql
   - supabase/sql/002_functions_and_seed.sql
2. 確認
   - select * from prompts; がデータ入り
   - RLS が有効（匿名サインイン後のクエリでアクセス）

## Edge Functions デプロイ
- Functions ルート: supabase/functions
  - create-room/ index.ts
  - join-room/ index.ts
  - start-game/ index.ts
- Supabase CLI 例
  - supabase functions deploy create-room
  - supabase functions deploy join-room
  - supabase functions deploy start-game

## フロント接続メモ
- 匿名サインイン: wait supabase.auth.signInAnonymously()
- 参加フロー
  1. ルーム作成 or 参加（Edge Function）
  2. my_member_id(room_id) を取得
  3. Realtime チャンネル oom:<room_id> に join して presence 管理
  4. DBの ounds/guesses を postgres_changes で購読

## 進行/採点の要点
- 正解判定: 完全一致（今は厳密）。将来 fuzzy 化は ward_guess_points 差し替えで対応
- スコア: 最初の正解10点、以降5点。出題者ボーナス=正解者×2点（ビューで加算）

## 注意点
- ルーム名は一意。ホスト退室時はルームが削除される
- 描画ストロークは永続化しない（Realtime broadcastのみ）
