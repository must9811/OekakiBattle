# アーキテクチャ概要（MVP）

## 全体像
- フロントエンド: Next.js（Netlify デプロイ）
- バックエンド: Supabase（PostgreSQL, Realtime, Edge Functions, Storage）
-- 認証: Supabase Auth（メール/パスワード、任意）

## データフロー
- ルーム作成/入室: フロント → Edge Functions（`create-room` / `join-room`）→ RPC 実行
- ゲーム開始: フロント（ホスト）→ `start-game` Edge Function → RPC `start_game`
- ラウンド進行:
  - 正解発生時: `guesses` INSERT → トリガ `on_correct_advance` → RPC `advance_round`
  - 時間切れ時: フロントで 5 秒オーバーレイ表示後、ホストが `advance_round` を呼ぶ（他クライアントはRealtimeで追随）
- リザルト表示: `rooms.status = 'finished'` の間、`v_room_scores` を表示
- 終了/退室: ホストが `end_game`（ルーム削除）、ゲストは `room_members` DELETE

## リアルタイム
- DB変更は `rooms`, `room_members`, `rounds`, `guesses` を `postgres_changes` で購読
- 描画同期は Realtime チャンネル `room:<room_id>` の broadcast/self:true を利用（非永続）

## エラーハンドリング
- 主なエラーは Edge Functions が 400/409 を返却
- UI では部屋名重複/満員/パスワード不一致などを日本語化して表示

## セキュリティ
- RLS によりルーム/履歴スコープでのアクセス制御を実施
- ルームパスワードは pgcrypto.crypt でハッシュ
- ホスト退室/終了でルームを削除（クリーンアップ）
## 追加機能（ログイン後）
- ゲーム履歴（いつ、どの部屋で、誰と、スコア、ラウンド絵）を保存
- アカウント設定（ユーザー名/パスワード変更）
