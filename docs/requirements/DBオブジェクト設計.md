# DBオブジェクト設計

## 1. 目的
DBに定義される型/関数/トリガ/ビュー/ポリシーの責務を整理する。

## 2. 型（Enum）
- `room_status`: `lobby`, `in_progress`, `finished`
- `round_status`: `pending`, `active`, `ended`, `skipped`

## 3. 関数（Function）
### 3.1 ユーティリティ
- `touch_updated_at()`
  - `rooms.updated_at` を自動更新
- `normalize_text(t text)`
  - `trim + lower` の正規化
- `verify_room_password(p_room_id, p_password)`
  - ハッシュ照合
- `is_room_member(p_room_id)` / `is_room_host(p_room_id)` / `is_drawer(p_round_id)`
  - 権限判定
- `my_member_id(p_room_id)`
  - 自身の `room_members.id` を取得

### 3.2 採点/進行
- `award_guess_points()`
  - 正解判定とスコア付与（初正解のみ +5）
- `advance_round(p_room_id)`
  - 現在ラウンドを終了し次を開始、無ければ `finished`
- `on_correct_advance()`
  - 初正解で `advance_round` を自動実行

### 3.3 RPC（SECURITY DEFINER）
- `create_room(p_name, p_password, p_username, p_max, p_rounds, p_time)`
- `join_room(p_name, p_password, p_username)`
- `start_game(p_room_id)`
- `end_game(p_room_id)`
- `get_active_prompt(p_room_id)`
- `get_room_members(p_room_id)`

## 4. トリガ
- `trg_rooms_updated_at`
  - rooms 更新時に `updated_at` を更新
- `trg_award_guess`
  - guesses INSERT 前に採点
- `trg_host_leave_cleanup`
  - ホスト退出時にルーム削除
- `trg_on_correct_advance`
  - 正解発生時の自動進行

## 5. ビュー
- `v_room_scores`
  - 回答ポイント + 出題者ボーナス(+3) の合算

## 6. RLSポリシー（要点）
- rooms: 参照は全員、更新/削除はホスト
- room_members: 自分の行は参照/更新可、ホストは同ルーム全行参照可
- rounds: 参照は同ルーム、更新はホスト
- guesses: 参照は同ルーム、挿入はメンバーかつ出題者以外

## 7. Realtime 公開
- `supabase_realtime` に `rooms/room_members/rounds/guesses` を登録
