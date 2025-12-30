# 開発メモ / セットアップ（実装同期）

## 前提
- Supabase プロジェクト作成済
- 匿名サインイン（Anonymous Sign-in）が有効
- Netlify で Next.js をデプロイ（フロントから Supabase を利用）

## 環境変数
- フロント（Next.js）
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Edge Functions
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`

## DB 反映手順
1. `supabase/sql/000_init_oekaki_battle.sql` を適用（初期化/関数/トリガ/シードを一括）
2. 確認
   - `select * from prompts;` がデータ入り
   - RLS 有効（匿名サインイン後のクエリでアクセス）

## Edge Functions デプロイ
- Functions ルート: `supabase/functions`
  - `create-room/ index.ts`
  - `join-room/ index.ts`
  - `start-game/ index.ts`
  - `advance-round/ index.ts`
  - `end-game/ index.ts`
- Supabase CLI 例
  - `supabase functions deploy create-room`
  - `supabase functions deploy join-room`
  - `supabase functions deploy start-game`
  - `supabase functions deploy advance-round`
  - `supabase functions deploy end-game`

## フロント接続メモ
- 匿名サインイン: `await supabase.auth.signInAnonymously()`
- 参加フロー
  1. ルーム作成 or 参加（Edge Function）
  2. `my_member_id(room_id)` を取得
  3. Realtime チャンネル `room:<room_id>` に join して描画同期（broadcast/self:true）
  4. DBの `rounds/guesses` を `postgres_changes` で購読

## 進行/採点の要点
- 正解判定: 完全一致（trim+lower）
- スコア: 最速正解者のみ +1 点。制限時間内に正解がいれば出題者に +1 点（ビューで加算）。以降の正解は無効
- 初正解で DB トリガにより `advance_round` が自動実行。フロントは5秒モーダル後に同期

## 注意点
- ルーム名は一意。ホスト退室/終了時はルームが削除される
- 描画ストロークは永続化しない（Realtime broadcast のみ）
