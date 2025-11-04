# DB設計書（MVP v1 実装同期）

本ドキュメントは「オンラインお絵描きあてバトル」MVPのSupabase(PostgreSQL)設計を示します。UIはログイン無しですが、クライアントでは Supabase の匿名サインインを使用し、RLS を有効化しています。

## 目的
- ルーム単位の一時的な対戦体験を支える最小DB
- 出題者/回答者のロール制御、採点、スコア集計、進行をサーバー主導で担保
- Realtime 連携（テーブル変更の購読）を前提に、整合性は DB 側で確保

## エンティティ
- rooms
  - ルーム本体。部屋名ユニーク、ホスト=作成者、状態（lobby/in_progress/finished）
  - `password_hash` は pgcrypto.crypt でハッシュ化
  - `round_time_sec`（30〜300）、`rounds_total`（1〜20）
- room_members
  - ルーム参加者（匿名ユーザーIDと表示名、ホストフラグ）。退出は `left_at` で管理
  - ホスト行が削除されるとトリガでルーム自体を削除
  - 一意制約: `(room_id, user_id)`, `(room_id, username)`、`username` 長さ1–16
- prompts
  - 出題辞書（`word`, `category`, `is_active`）。MVPは簡易シード
- rounds
  - ラウンド情報。`drawer_member_id`, `prompt_id`, `status`（pending/active/ended/skipped）, `started_at/ended_at`
  - 一意制約: `(room_id, number)`
- guesses
  - 回答ログ。`is_correct`, `awarded_points` はトリガで自動計算

- v_room_scores（ビュー）
  - スコア集計ビュー。回答ポイント合計 + 出題者ボーナス（そのラウンドで正解者がいれば+3）を合算

## 主要関数/トリガ
- `normalize_text(text)`
  - `trim + lower` の正規化（かな/漢字変換は無し）
- `award_guess_points()` トリガ（guesses BEFORE INSERT）
  - 正解判定: `normalize_text(content) == normalize_text(prompt.word)`
  - 出題者自身の回答は常に不正解（0点）
  - 同一メンバーの同ラウンド二重正解は 0 点
  - 最初の正解「のみ」+5 点、それ以外の正解は無効（不正解として扱う/0点）
- `handle_host_leave()` トリガ（room_members AFTER DELETE）
  - ホストが退出→ルーム削除（関連行は cascade）
- `on_correct_advance()` トリガ（guesses AFTER INSERT）
  - ラウンドで初めて正解が出た瞬間に `advance_round` を呼び、即座に次ラウンド/終了へ遷移

## RPC（SECURITY DEFINER）
- `create_room(p_name, p_password, p_username, p_max, p_rounds, p_time) -> jsonb`
  - ルーム作成 + ホスト入室。重複名は `room_name_taken`
- `join_room(p_name, p_password, p_username) -> jsonb`
  - 入室処理（パスワード検証、満員/重複名チェック）
- `start_game(p_room_id)`
  - ホストのみ。現在のメンバーをランダム巡回でラウンド割当、各ラウンドにランダムお題。1ラウンド目を active
- `advance_round(p_room_id) -> jsonb`
  - 現在 active を ended にして次の pending を active に。なければ `rooms.status = 'finished'`
- `end_game(p_room_id)`
  - ホストのみ。ルーム削除
- `get_active_prompt(p_room_id) -> { prompt, length, round_number }`
  - メンバーのみ。出題者には `prompt` 文字列、回答者には `length` のみ返す
- `get_room_members(p_room_id) -> setof (id, username, is_host)`
  - メンバーのみ。参加者一覧を joined 順に返す
- `my_member_id(p_room_id) -> uuid`
  - 自身の `room_members.id` を取得

## RLSポリシー（要点）
- rooms: `SELECT` 全員可、`INSERT` 認証済、`UPDATE/DELETE` ホストのみ
- room_members: 自分の行は参照可、ホストは自ルームの全行参照可。`INSERT/UPDATE/DELETE` は本人のみ
- rounds: 同一ルームのみ参照可。書き込みはホストのみ
- guesses: 同一ルーム参照可、`INSERT` はメンバーかつ出題者でないこと

## Realtime
- `supabase_realtime` パブリケーションに `rooms`, `room_members`, `rounds`, `guesses` を追加
- フロントの購読例
  - 参加者一覧: `room_members`（または `get_room_members` RPC）
  - ラウンド進行/開始: `rounds`
  - 回答/正解通知: `guesses`
- 描画ストローク同期は DB ではなく Realtime チャンネル（broadcast）を使用（永続化なし）

## 想定クエリ
- スコアボード: `select * from v_room_scores where room_id = :room_id order by points desc;`
- 参加者一覧: `select * from room_members where room_id = :room_id and left_at is null;`
- 現在ラウンド: `select * from rounds where room_id = :room_id and status = 'active' limit 1;`

## 非機能
- 重要データは少量。描画ストロークは非永続化で DB 負荷を最小化
- 将来の曖昧一致など高度な採点は関数差し替えで対応可能
