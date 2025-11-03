# RPC 一覧（Supabase / SECURITY DEFINER）

各 RPC は匿名サインイン済みユーザーを前提とし、RLS の上位で動作します。返却スキーマは実装（`supabase/sql/000_init_oekaki_battle.sql`）に準拠。

- create_room(p_name text, p_password text, p_username text, p_max int, p_rounds int, p_time int) -> jsonb
  - 入力: 部屋名、平文パスワード、表示名、最大人数・ラウンド・制限時間
  - 戻り: `{ room_id, member_id }`
  - 例外: `room_name_taken`

- join_room(p_name text, p_password text, p_username text) -> jsonb
  - 入力: 部屋名、平文パスワード、表示名
  - 戻り: `{ room_id, member_id }`
  - 例外: `room_not_found`, `invalid_password`, `room_full`, `room_not_joinable`, 重複ユーザー名

- start_game(p_room_id uuid) -> void
  - ホストのみ。メンバーを巡回して各ラウンドの `drawer_member_id` を割当、ランダムお題を付与。1 ラウンド目を `active`

- advance_round(p_room_id uuid) -> jsonb
  - 現在 `active` を `ended` にし、次の `pending` を `active` に。なければ `rooms.status = 'finished'`
  - 戻り: `{ finished: boolean, ended_round: number, ended_word: string | null, next_round: number | null }`

- end_game(p_room_id uuid) -> void
  - ホストのみ。ルーム削除

- get_active_prompt(p_room_id uuid) -> jsonb
  - メンバーのみ。出題者には `{ prompt, length, round_number }`（prompt あり）、回答者には `{ prompt: null, length, round_number }`

- get_room_members(p_room_id uuid) -> setof (id uuid, username text, is_host boolean)
  - メンバーのみ。joined 順

- my_member_id(p_room_id uuid) -> uuid
  - 自身の `room_members.id`

備考
- 初正解で `on_correct_advance` トリガが `advance_round` を自動実行します（クライアントの明示呼び出し不要）。
- 描画同期は RPC/DB 経由ではなく Realtime チャンネルの broadcast を利用します。
