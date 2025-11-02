# Edge Functions / API 仕様（MVP）

フロントは @supabase/supabase-js で匿名サインイン後、以下のEdge Functionを呼び出します。
各リクエストは Authorization: Bearer <JWT> を付与してください。

## POST /functions/v1/create-room
- Body: { name: string, password: string, username: string, maxPlayers?: number, roundsTotal?: number, roundTimeSec?: number }
- 成功: { room: { room_id: uuid, member_id: uuid } }
- 失敗: 400 { error: string }
- 備考: ルーム作成 + ホストとして入室。パスワードはDBでハッシュ化

## POST /functions/v1/join-room
- Body: { name: string, password: string, username: string }
- 成功: { joined: { room_id: uuid, member_id: uuid } }
- 失敗: 400 { error: 'room_not_found' | 'invalid_password' | 'room_full' | ... }

## POST /functions/v1/start-game
- Body: { roomId: uuid }
- 成功: { ok: true }
- 失敗: 400 { error: 'forbidden' | ... }
- 備考: ホストのみ実行可能。ラウンドを生成し ooms.status を in_progress に更新

## DB 直接操作（RLS）
- 回答投稿: insert into guesses(room_id, round_id, member_id, content) values (...) で投稿
  - member_id は select my_member_id(:room_id) で取得可能
  - 正解判定・ポイントはトリガで自動計算
- 参加者離脱: update room_members set left_at = now() where id = :my_member_id もしくは delete from room_members where id = :my_member_id
  - ホストが離脱した場合、トリガでルーム自体が削除されます

## Realtime チャンネル/購読
- DB変更: ooms, room_members, rounds, guesses を postgres_changes で購読
- 描画同期: ealtime channel: room:<room_id> を使用し roadcast と presence を活用
  - 例: supabase.channel('room:' + roomId).on('broadcast', { event: 'stroke' }, cb).subscribe()

