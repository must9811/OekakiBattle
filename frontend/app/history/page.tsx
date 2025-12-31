"use client"
import { useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabaseClient"
import { useAnonAuth } from "@/lib/useAnonAuth"

type GameSession = {
  id: string
  room_name: string
  rounds_total: number
  round_time_sec: number
  started_at: string
  ended_at: string | null
}

type Participant = {
  session_id: string
  user_id: string
  username_at_time: string
  is_host: boolean
  score: number
}

export default function HistoryPage() {
  const ready = useAnonAuth()
  const [loading, setLoading] = useState(true)
  const [sessions, setSessions] = useState<GameSession[]>([])
  const [participants, setParticipants] = useState<Participant[]>([])
  const [error, setError] = useState<string | undefined>()
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)

  useEffect(() => {
    if (!ready) return
    let mounted = true
    const load = async () => {
      setLoading(true)
      const { data: userData } = await supabase.auth.getUser()
      const user = userData.user
      if (!user || user.is_anonymous) {
        if (mounted) {
          setIsLoggedIn(false)
          setLoading(false)
        }
        return
      }
      setIsLoggedIn(true)
      setCurrentUserId(user.id)
      const { data: sessionRows, error: sessionError } = await supabase
        .from("game_sessions")
        .select("id,room_name,rounds_total,round_time_sec,started_at,ended_at")
        .order("started_at", { ascending: false })
      if (sessionError) {
        if (mounted) {
          setError("履歴の取得に失敗しました。")
          setLoading(false)
        }
        return
      }
      const rows = (sessionRows as GameSession[]) || []
      const sessionIds = rows.map(r => r.id)
      const { data: participantRows, error: participantError } = sessionIds.length > 0
        ? await supabase
            .from("game_participants")
            .select("session_id,user_id,username_at_time,is_host,score")
            .in("session_id", sessionIds)
        : { data: [] as Participant[], error: null }
      if (participantError) {
        if (mounted) {
          setError("履歴の取得に失敗しました。")
          setLoading(false)
        }
        return
      }
      if (mounted) {
        setSessions(rows)
        setParticipants((participantRows as Participant[]) || [])
        setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [ready])

  const participantsBySession = useMemo(() => {
    const map = new Map<string, Participant[]>()
    for (const p of participants) {
      const list = map.get(p.session_id) ?? []
      list.push(p)
      map.set(p.session_id, list)
    }
    return map
  }, [participants])

  return (
    <div className="homeBg">
      <main className="container grid" style={{ gap: 16 }}>
        <div className="panelHeader">
          <h1 className="title">プレイ履歴</h1>
          <a className="button ghost" href="/">トップへ戻る</a>
        </div>
        {!ready || loading ? (
          <p className="subtitle">読み込み中…</p>
        ) : !isLoggedIn ? (
          <div className="card">
            <p className="subtitle">プレイ履歴を表示するにはログインが必要です。</p>
            <a className="button" href="/">ログインへ戻る</a>
          </div>
        ) : error ? (
          <div className="card">
            <p className="subtitle">{error}</p>
          </div>
        ) : sessions.length === 0 ? (
          <div className="card">
            <p className="subtitle">履歴がありません。</p>
          </div>
        ) : (
          <div className="grid" style={{ gap: 12 }}>
            {sessions.map((s) => {
              const list = (participantsBySession.get(s.id) ?? []).slice().sort((a, b) => b.score - a.score)
              const my = list.find(p => p.user_id === currentUserId)
              return (
                <div key={s.id} className="card">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>{s.room_name}</strong>
                    <span className="subtitle">
                      {new Date(s.started_at).toLocaleString()} 〜 {s.ended_at ? new Date(s.ended_at).toLocaleString() : "--"}
                    </span>
                  </div>
                  <div className="row" style={{ gap: 12, marginTop: 8 }}>
                    <span className="badge">ラウンド {s.rounds_total}</span>
                    <span className="badge">制限時間 {Math.round(s.round_time_sec / 60)}分</span>
                    {my && <span className="badge">あなたのスコア {my.score}点</span>}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <h4>参加者</h4>
                    <ul>
                      {list.map(p => (
                        <li key={`${p.session_id}-${p.user_id}`}>
                          {p.username_at_time}{p.is_host ? " (ホスト)" : ""} — {p.score}点
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
