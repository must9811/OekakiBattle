# DB設計書（MVP v1）

本ドキュメントは「オンラインお絵描きあてバトル」MVPのSupabase(PostgreSQL)設計を示します。ログインUIは無しだが、クライアントではSupabaseの匿名サインインを使用する前提でRLSを有効化しています。

## 目的
- ルーム単位の一時的な対戦体験を支える最小DB
- 出題者/回答者のロール制御、採点、スコア集計、進行の最小単位を提供
- Realtime連携（テーブル変更の購読）を前提に、整合性はDB側で担保

## エンティティ
- ooms
  - ルーム本体。部屋名ユニーク、ホスト=作成者、状態管理（lobby/in_progress/finished）
  - password_hash は pgcrypto.crypt でハッシュ化
- oom_members
  - ルーム参加者（匿名ユーザーIDと表示名、ホストフラグ）。退室で left_at 設定
  - ホスト行が削除されるとトリガでルーム自体を削除
- prompts
  - 出題辞書（word, category, is_active）。MVPは簡易シード
- ounds
  - ラウンド情報。出題者、割当お題、状態（pending/active/ended/skipped）
- guesses
  - 回答ログ。正解判定とポイント付与はトリガで自動計算
- _room_scores
  - スコア集計ビュー。正解ポイント合計 + 出題者ボーナス（正解者数×2）を合算

## 主な制約
- oom_members: (room_id, user_id) 一意、(room_id, username) 一意、username 長さ1–16
- ounds: (room_id, number) 一意
- guesses: (room_id, round_id) 外部キー整合性（ラウンドと同一ルーム）

## ルール/トリガ
- ward_guess_points トリガ
  - 正解判定: 正規化（trim+lower）でお題word一致
  - 同一メンバーの同ラウンド二重正解は0点
  - 最初の正解: 10点、以降の正解: 5点
- handle_host_leave トリガ
  - ホストが退出→ルーム削除（カスケードで関連行削除）

## RLSポリシー（要点）
- ooms selectは全員可、insertは認証済、update/deleteはホストのみ
- oom_members 同一ルームのメンバーのみ参照可、insertは自身のuser_idでのみ可、update/deleteは自身のみ
- ounds 同一ルームのみ参照可、書き込みはホストのみ
- guesses 同一ルーム参照可、insertはメンバーかつ出題者でないこと

## Realtime
- supabase_realtime パブリケーションに ooms, room_members, rounds, guesses を追加
- フロントは以下を購読
  - 参加者一覧: oom_members
  - ラウンド進行/開始: ounds
  - 回答/正解通知: guesses
- 描画ストローク同期はDBではなくRealtimeチャンネルのbroadcast/presenceを使用（永続化しない）

## ゲーム進行
- start_game(room_id)
  - ホストのみ実行
  - 現在のメンバーをランダム並び替え→ラウンド数ぶん巡回割当
  - 各ラウンドにランダムお題付与。1ラウンド目を ctive に、以降は pending

## 想定クエリ
- スコアボード: select * from v_room_scores where room_id = :room_id order by points desc;
- 参加者一覧: select * from room_members where room_id = :room_id and left_at is null;
- 現在ラウンド: select * from rounds where room_id = :room_id and status = 'active' limit 1;

## 非機能
- 重要データは少量。描画ストロークは非永続化。DB負荷を最小化
- 将来の曖昧一致など高度な採点は関数差し替えで対応可能
