# タスクチェックリスト（MVP）

## 事前準備
- [ ] Supabase プロジェクト作成・Anon サインイン有効化
- [ ] Netlify プロジェクト作成・環境変数設定（NEXT_PUBLIC_SUPABASE_URL/ANON_KEY）

## DB / Realtime
- [ ] 001_schema.sql 適用
- [ ] 002_functions_and_seed.sql 適用
- [ ] Realtime: ooms, room_members, rounds, guesses の postgres_changes を購読
- [ ] Realtime: 描画用 broadcast/presence チャンネル実装（フロント）

## Edge Functions
- [ ] create-room デプロイ
- [ ] join-room デプロイ
- [ ] start-game デプロイ

## フロント（Next.js）
- [ ] 匿名サインイン実装
- [ ] ルーム作成/参加 UI + バリデーション
- [ ] ロビー: 参加者一覧・開始ボタン（ホストのみ）
- [ ] ゲーム画面: キャンバス同期（Realtime broadcast）、タイマー、回答UI
- [ ] 正解通知/スコア表示（guesses, _room_scores 購読）
- [ ] リザルト画面

## 運用/テスト
- [ ] 少人数 E2E（2–3名）
- [ ] 回線不安定時の再接続（presence 再同期）
- [ ] ルーム削除（ホスト離脱）動作確認
