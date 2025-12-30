# Edge Functions / API 仕様（MVP 実装同期）

フロントは `@supabase/supabase-js` で匿名サインイン後、以下の Edge Function を呼び出します。
各リクエストは `Authorization: Bearer <JWT>` を付与してください。

## POST /functions/v1/create-room
- Body: `{ name: string, password: string, username: string, maxPlayers?: number, roundsTotal?: number, roundTimeSec?: number }`
- 成功: `{ room: { room_id: uuid, member_id: uuid } }`
- 失敗: `409 { error: 'room_name_taken' }` / `400 { error: string }`
- 備考: ルーム作成 + ホストとして入室。パスワードは DB でハッシュ化

## POST /functions/v1/join-room
- Body: `{ name: string, password: string, username: string }`
- 成功: `{ joined: { room_id: uuid, member_id: uuid } }`
- 失敗: `400 { error: 'room_not_found' | 'invalid_password' | 'room_full' | ... }`

## POST /functions/v1/start-game
- Body: `{ roomId: uuid }`
- 成功: `{ ok: true }`
- 失敗: `400 { error: 'forbidden' | ... }`
- 備考: ホストのみ実行可能。ラウンドを生成し `rooms.status` を `in_progress` に更新

## POST /functions/v1/advance-round
- Body: `{ roomId: uuid }`
- 成功: `{ finished: boolean, ended_round: number, ended_word: string | null, next_round: number | null }`
- 備考: 正解/時間切れ後の進行用。通常は DB トリガで自動進行するが、フォールバックとして使用

## POST /functions/v1/end-game
- Body: `{ roomId: uuid }`
- 成功: `{ ok: true }`
- 備考: ホストのみ。ルームを削除（参加者も退出状態）

## DB 直接操作（RLS）
- 回答投稿: `insert into guesses(room_id, round_id, member_id, content) values (...)`
  - `member_id` は `select my_member_id(:room_id)` で取得可能
  - 正解判定・ポイント付与はトリガで自動計算（最初+1、以降0）
- 参加者離脱: `delete from room_members where id = :my_member_id`
  - ホストが離脱した場合、トリガでルーム自体が削除されます

## Realtime チャンネル/購読
- DB変更: `rooms`, `room_members`, `rounds`, `guesses` を `postgres_changes` で購読
- 描画同期: Realtime チャンネル `room:<room_id>` を使用し broadcast を活用
  - 例: `supabase.channel('room:' + roomId).on('broadcast', { event: 'stroke' }, cb).subscribe()`
