'use client'
import CanvasBoard, { type CanvasBoardHandle } from '@/components/CanvasBoard'
import { supabase } from '@/lib/supabaseClient'
import { useAnonAuth } from '@/lib/useAnonAuth'
import { useParams } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import confetti from 'canvas-confetti'

type Room = { id: string; name: string; status: 'lobby' | 'in_progress' | 'finished'; round_time_sec: number; rounds_total: number; host_user: string }
type Member = { id: string; username: string; is_host: boolean }
type Round = { id: string; room_id: string; number: number; drawer_member_id: string; prompt_id: string; status: 'pending' | 'active' | 'ended' | 'skipped'; started_at: string | null }
type RoundSnapshot = {
  roundId: string
  roundNumber: number
  dataUrl: string
  drawerName?: string
  promptWord?: string | null
  winnerName?: string | null
  durationSec?: number | null
}

export default function RoomPage() {
  const ready = useAnonAuth()
  const params = useParams<{ roomName: string }>()
  const roomName = decodeURIComponent(params.roomName)

  const [room, setRoom] = useState<Room | undefined>()
  const [members, setMembers] = useState<Member[]>([])
  const [activeRound, setActiveRound] = useState<Round | undefined>()
  const [memberId, setMemberId] = useState<string | undefined>()
  const [isHost, setIsHost] = useState(false)
  const [drawerMemberId, setDrawerMemberId] = useState<string | undefined>()
  const [guess, setGuess] = useState('')
  const [messages, setMessages] = useState<string[]>([])
  const [promptWord, setPromptWord] = useState<string | null>(null)
  const [promptLen, setPromptLen] = useState<number>(0)
  const [promptCategory, setPromptCategory] = useState<string | null>(null)
  const [timeLeft, setTimeLeft] = useState<number>(0)
  const [overlayMsg, setOverlayMsg] = useState<string | null>(null)
  const [advancedThisRound, setAdvancedThisRound] = useState(false)
  const [overlayCountdown, setOverlayCountdown] = useState<number | null>(null)
  const [celebrate, setCelebrate] = useState(false)
  const [overlayVariant, setOverlayVariant] = useState<'correct' | 'timeout' | 'neutral'>('neutral')
  const roomIdRef = useRef<string | null>(null)
  const memberNameByIdRef = useRef<Record<string, string>>({})
  const [finishedAtLeastOnce, setFinishedAtLeastOnce] = useState(false)
  const [scores, setScores] = useState<Record<string, number>>({})
  const [roundSnapshots, setRoundSnapshots] = useState<RoundSnapshot[]>([])
  const [nextRoundsTotal, setNextRoundsTotal] = useState<number>(3)
  const [nextRoundTimeSec, setNextRoundTimeSec] = useState<number>(60)
  const [showResult, setShowResult] = useState(false)
  const [hadGuestsOnce, setHadGuestsOnce] = useState(false)
  const [hostReturnScheduled, setHostReturnScheduled] = useState(false)
  const isHostRef = useRef(false)
  const roundTimeRef = useRef<number>(60)
  const lastRoundRef = useRef<Round | undefined>(undefined)
  const canvasRef = useRef<CanvasBoardHandle | null>(null)
  const confettiFiredRef = useRef(false)
  const overlayIntervalRef = useRef<number | null>(null)
  const overlayTimeoutRef = useRef<number | null>(null)
  const suppressUntilRef = useRef<number | null>(null)
  const historySavedRef = useRef(false)
  const roundSnapshotsRef = useRef<RoundSnapshot[]>([])
  // Flowing comments over canvas (NicoNico-like)
  type FlyItem = { id: number, text: string, top: number }
  const [flyItems, setFlyItems] = useState<FlyItem[]>([])
  const flyNextId = useRef(1)
  const flyLayerRef = useRef<HTMLDivElement | null>(null)
  const flyLaneIdxRef = useRef(0)
  const flyLineHeight = 26 // px
  const flySpeedPxPerSec = 100 // flowing speed
  function addFlyComment(text: string) {
    if (!text) return
    const layer = flyLayerRef.current
    const h = layer?.clientHeight ?? 240
    const lanes = Math.max(3, Math.floor(h / flyLineHeight))
    const lane = flyLaneIdxRef.current % lanes
    flyLaneIdxRef.current++
    const top = lane * flyLineHeight + 6 // small padding
    const id = flyNextId.current++
    setFlyItems(items => [...items, { id, text, top }])
  }

  useEffect(() => {
    if (!ready) return
    let cleanup: (() => void) | undefined
      ; (async () => {
        const { data: roomData } = await supabase.from('rooms').select('*').eq('name', roomName).single()
        if (!roomData) return
        setRoom(roomData as Room)
        roomIdRef.current = (roomData as Room).id

        const my = await supabase.rpc('my_member_id', { p_room_id: roomData.id })
        const myId = my.data as string | null
        if (!myId) {
          setMessages(m => [...m, 'この部屋のメンバーではありません。トップへ戻って入室してください。'])
          return
        }
        setMemberId(myId)
        const host = (roomData.host_user) === (await supabase.auth.getUser()).data.user?.id
        setIsHost(host)
        isHostRef.current = host
        roundTimeRef.current = Number(roomData.round_time_sec || 60)

        await refreshMembers(roomData.id)
        await refreshRound(roomData.id)

        const ch = supabase.channel(`room-db:${roomData.id}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomData.id}` }, async () => { await refreshMembers(roomData.id) })
          .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'room_members' }, async (payload) => {
            const rid = (payload.old as any)?.room_id
            if (rid === roomData.id) {
              await refreshMembers(roomData.id)
            }
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds', filter: `room_id=eq.${roomData.id}` }, async () => {
            const now = Date.now()
            if (suppressUntilRef.current && now < suppressUntilRef.current) return
            await refreshRound(roomData.id)
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomData.id}` }, async (payload) => {
            if (payload.eventType === 'DELETE') {
              setMessages(m => [...m, '⚠️ ホストがゲームを中断しました。5秒後にトップへ戻ります。'])
              setOverlayMsg('ホストがゲームを中断しました。\n5秒後にトップへ戻ります。')
              setCelebrate(false)
              setOverlayVariant('neutral')
              setOverlayCountdown(5)
              if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null }
              if (overlayTimeoutRef.current) { window.clearTimeout(overlayTimeoutRef.current); overlayTimeoutRef.current = null }
              if (overlayIntervalRef.current) { window.clearInterval(overlayIntervalRef.current); overlayIntervalRef.current = null }
              overlayIntervalRef.current = window.setInterval(() => {
                setOverlayCountdown((c) => {
                  const v = (c ?? 1) - 1
                  if (v <= 0) {
                    if (overlayIntervalRef.current) { window.clearInterval(overlayIntervalRef.current); overlayIntervalRef.current = null }
                  }
                  return v
                })
              }, 1000)
              overlayTimeoutRef.current = window.setTimeout(() => {
                window.location.href = '/'
              }, 5000)
              return
            }

            setRoom(payload.new as any)
            roomIdRef.current = (payload.new as any)?.id ?? roomIdRef.current
            // ステータスが finished になったらメッセージとフラグ
            if ((payload.new as any)?.status === 'finished') {
              setFinishedAtLeastOnce(true)
              setMessages(m => [...m, '🎉 ゲーム終了！リザルトを表示します。'])
              const waitMs = suppressUntilRef.current ? Math.max(0, suppressUntilRef.current - Date.now()) : 0
              if (waitMs > 0) {
                setShowResult(false)
                window.setTimeout(() => {
                  setShowResult(true)
                }, waitMs)
              } else {
                setShowResult(true)
              }
              const currentRound = lastRoundRef.current ?? activeRound
              if (currentRound) {
                void captureRoundSnapshot(currentRound)
              }
            }
            if ((payload.new as any)?.status === 'in_progress') {
              setRoundSnapshots([])
              lastRoundRef.current = undefined
              setShowResult(false)
            }
          })
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'guesses', filter: `room_id=eq.${roomData.id}` }, async (payload) => {
            const g: any = payload.new

            // 先に名前だけは同期で引けるようローカルマップ参照
            const nm = memberNameByIdRef.current[g.member_id] || '匿名'

            // すべての回答をキャンバス上にも流す（表示はテキストのみ）
            if (g?.content) {
              addFlyComment(`${nm}: ${g.content}`)
            }

            if (g.is_correct) {
              // ここで「最優先で」ロック＆モーダルを立てる（await 禁止）
              setMessages(m => [...m, `✅ ${nm}が正解しました！ 正解: ${g.content}`])
              setOverlayMsg(`${nm}が正解しました！\n正解: ${g.content}`)
              setCelebrate(true)
              setOverlayVariant('correct')
              setOverlayCountdown(5)
              setAdvancedThisRound(true)
              suppressUntilRef.current = Date.now() + 5500

              // 既存のタイマー類を整理
              if (overlayTimeoutRef.current) { window.clearTimeout(overlayTimeoutRef.current); overlayTimeoutRef.current = null }
              if (overlayIntervalRef.current) { window.clearInterval(overlayIntervalRef.current); overlayIntervalRef.current = null }

              // 非ホスト向けのカウントダウンUI
              if (!isHostRef.current) {
                overlayIntervalRef.current = window.setInterval(() => {
                  setOverlayCountdown((c) => {
                    const v = (c ?? 1) - 1
                    if (v <= 0) {
                      if (overlayIntervalRef.current) { window.clearInterval(overlayIntervalRef.current); overlayIntervalRef.current = null }
                      setOverlayMsg(null); setOverlayCountdown(null)
                      // ここで抑止解除してから遷移
                      releaseSuppressionAndRefresh()
                    }
                    return v
                  })
                }, 1000)
              } else {
                // ホスト側も見た目のカウントダウンだけ進める
                const countdown = window.setInterval(() => {
                  setOverlayCountdown((c) => {
                    const v = (c ?? 1) - 1
                    if (v <= 0) {
                      window.clearInterval(countdown)
                      setOverlayMsg(null); setOverlayCountdown(null)
                      // ここで抑止解除してから遷移（進行はサーバのトリガー済み）
                      releaseSuppressionAndRefresh()
                    }
                    return v
                  })
                }, 1000)
              }

              // メンバー・スコアの更新は「後から・非同期」で
              void refreshMembers(roomData.id)
              void refreshScores(roomData.id)

              // 念のため 5 秒後にラウンド再取得（オーバーレイ消去も同時）
              overlayTimeoutRef.current = window.setTimeout(() => {
                overlayTimeoutRef.current = null
                setOverlayMsg(null); setOverlayCountdown(null)
                // 抑止解除してから遷移（保険）
                releaseSuppressionAndRefresh()
              }, 5000)


            } else {
              // 不正解メッセージ
              setMessages(m => [...m, `${nm}: ${g.content}`])
              // これも非同期でOK（表示をブロックしない）
              void refreshMembers(roomData.id)
              void refreshScores(roomData.id)
            }
          })

          .subscribe()
        cleanup = () => { ch.unsubscribe() }
      })()
    return () => { if (cleanup) cleanup() }
  }, [ready, roomName])

  useEffect(() => {
    roundSnapshotsRef.current = roundSnapshots
  }, [roundSnapshots])

  useEffect(() => {
    if (!room) return
    setNextRoundsTotal(Number(room.rounds_total || 3))
    setNextRoundTimeSec(Number(room.round_time_sec || 60))
    roundTimeRef.current = Number(room.round_time_sec || 60)
  }, [room?.rounds_total, room?.round_time_sec])

  useEffect(() => {
    if (!room) return
    if (room.status !== 'finished') {
      historySavedRef.current = false
      if (showResult) setShowResult(false)
      return
    }
    if (showResult) return
    const waitMs = suppressUntilRef.current ? Math.max(0, suppressUntilRef.current - Date.now()) : 0
    if (waitMs === 0) setShowResult(true)
  }, [room?.status, showResult])

  useEffect(() => {
    if (!overlayMsg) {
      confettiFiredRef.current = false
      if (celebrate) setCelebrate(false)
      if (overlayVariant !== 'neutral') setOverlayVariant('neutral')
      return
    }
    if (!celebrate || confettiFiredRef.current) return
    confettiFiredRef.current = true
    const defaults = { particleCount: 60, spread: 70, startVelocity: 45, gravity: 0.9, ticks: 220 }
    confetti({ ...defaults, origin: { x: 0.2, y: 0.6 } })
    confetti({ ...defaults, origin: { x: 0.8, y: 0.6 } })
    window.setTimeout(() => {
      confetti({ particleCount: 80, spread: 100, startVelocity: 55, gravity: 0.85, ticks: 240, origin: { x: 0.5, y: 0.4 } })
    }, 220)
  }, [overlayMsg, celebrate])

  async function refreshMembers(roomId: string) {
    const { data } = await supabase.rpc('get_room_members', { p_room_id: roomId })
    if (data) {
      const arr = data as Member[]
      setMembers(arr)
      const map: Record<string, string> = {}
      for (const m of arr) map[(m as any).id] = m.username
      memberNameByIdRef.current = map
    }
  }

  useEffect(() => {
    if (!isHost || !room) return
    if (members.length > 1) {
      setHadGuestsOnce(true)
      return
    }
    if (!hadGuestsOnce || hostReturnScheduled) return
    const onlyHost = members.length === 1 && members[0]?.is_host
    if (!onlyHost) return
    setHostReturnScheduled(true)
    setMessages(m => [...m, '⚠️ ゲストが全員退出しました。5秒後にトップへ戻ります。'])
    setOverlayMsg('ゲストが全員退出しました。\n5秒後にトップへ戻ります。')
    setCelebrate(false)
    setOverlayVariant('neutral')
    setOverlayCountdown(5)
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null }
    if (overlayTimeoutRef.current) { window.clearTimeout(overlayTimeoutRef.current); overlayTimeoutRef.current = null }
    if (overlayIntervalRef.current) { window.clearInterval(overlayIntervalRef.current); overlayIntervalRef.current = null }
    overlayIntervalRef.current = window.setInterval(() => {
      setOverlayCountdown((c) => {
        const v = (c ?? 1) - 1
        if (v <= 0) {
          if (overlayIntervalRef.current) { window.clearInterval(overlayIntervalRef.current); overlayIntervalRef.current = null }
        }
        return v
      })
    }, 1000)
    overlayTimeoutRef.current = window.setTimeout(async () => {
      try {
        const token = (await supabase.auth.getSession()).data.session?.access_token
        const { error } = await supabase.functions.invoke('end-game', {
          body: { roomId: room.id },
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        })
        if (error) {
          await supabase.rpc('end_game', { p_room_id: room.id })
        }
      } catch {}
      window.location.href = '/'
    }, 5000)
  }, [isHost, room, members, hadGuestsOnce, hostReturnScheduled])

  async function refreshRound(roomId: string) {
    // 正解モーダルやタイムアウトモーダルの表示中はラウンド更新を抑止
    if (suppressUntilRef.current && Date.now() < suppressUntilRef.current) {
      return
    }

    const { data: aRound } = await supabase
      .from('rounds')
      .select('*')
      .eq('room_id', roomId)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()

    const prev = lastRoundRef.current
    const next = aRound ? (aRound as Round) : undefined
    if (prev && (!next || prev.id !== next.id)) {
      void captureRoundSnapshot(prev)
    }

    if (aRound) {
      setActiveRound(aRound as Round)
      setDrawerMemberId((aRound as any).drawer_member_id)
      await refreshPrompt(roomId, (aRound as any).prompt_id)
      await refreshScores(roomId)
      startTimer(aRound as Round)
      setAdvancedThisRound(false)
      setOverlayMsg(null)
      setOverlayCountdown(null)
      if (overlayIntervalRef.current) { window.clearInterval(overlayIntervalRef.current); overlayIntervalRef.current = null }
      if (overlayTimeoutRef.current) { window.clearTimeout(overlayTimeoutRef.current); overlayTimeoutRef.current = null }
      lastRoundRef.current = aRound as Round
    } else {
      setActiveRound(undefined)
      setDrawerMemberId(undefined)
      setPromptWord(null)
      setPromptLen(0)
      setPromptCategory(null)
      setTimeLeft(0)
      lastRoundRef.current = undefined
    }
  }


  async function refreshPrompt(roomId: string, promptId?: string) {
    const res = await supabase.rpc('get_active_prompt', { p_room_id: roomId })
    const p = res.data as any
    if (p) {
      setPromptWord(p.prompt)
      setPromptLen(p.length || 0)
      setPromptCategory(p.category)
    }

    // RPCでカテゴリが来ない場合は prompts から補完
    const id = promptId ?? (activeRound as any)?.prompt_id
    if (id) {
      const { data } = await supabase
        .from('prompts')
        .select('category')
        .eq('id', id)
        .maybeSingle()
      setPromptCategory((data as any)?.category ?? null)
    } else {
      setPromptCategory(null)
    }

  }

  async function captureRoundSnapshot(round: Round) {
    const dataUrl = canvasRef.current?.getSnapshotDataUrl()
    if (!dataUrl) return
    const drawerName = memberNameByIdRef.current[round.drawer_member_id]
    setRoundSnapshots(prev => {
      if (prev.some(p => p.roundId === round.id)) return prev
      return [...prev, { roundId: round.id, roundNumber: round.number, dataUrl, drawerName }]
    })

    const { data: roundRow } = await supabase
      .from('rounds')
      .select('id,started_at,ended_at,prompt_id')
      .eq('id', round.id)
      .maybeSingle()

    let durationSec: number | null = null
    if ((roundRow as any)?.started_at && (roundRow as any)?.ended_at) {
      const startMs = Date.parse((roundRow as any).started_at)
      const endMs = Date.parse((roundRow as any).ended_at)
      if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
        durationSec = Math.max(0, Math.round((endMs - startMs) / 1000))
      }
    }

    let promptWord: string | null = null
    const pid = (roundRow as any)?.prompt_id ?? round.prompt_id
    if (pid) {
      promptWord = await fetchPromptWordById(pid)
    }

    let winnerName: string | null = null
    const { data: guessRow } = await supabase
      .from('guesses')
      .select('member_id, created_at')
      .eq('round_id', round.id)
      .eq('is_correct', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if ((guessRow as any)?.member_id) {
      const winId = (guessRow as any).member_id as string
      winnerName = memberNameByIdRef.current[winId] ?? null
      if (!winnerName) {
        const { data: memberRow } = await supabase
          .from('room_members')
          .select('username')
          .eq('id', winId)
          .maybeSingle()
        winnerName = (memberRow as any)?.username ?? null
      }
    }

    setRoundSnapshots(prev => prev.map(p => (
      p.roundId === round.id
        ? { ...p, promptWord, winnerName, durationSec }
        : p
    )))
  }

  async function refreshScores(roomId: string) {
    const { data, error } = await supabase.from('v_room_scores').select('*').eq('room_id', roomId)
    if (!error && data) {
      const m: Record<string, number> = {}
      for (const r of data as any[]) m[r.member_id] = r.points
      setScores(m)
    }
  }

  const timerRef = useRef<number | null>(null)

  // 指定された prompt_id からお題の文字列を取得（失敗時は null）
  async function fetchPromptWordById(promptId: string): Promise<string | null> {
    if (!promptId) return null
    const { data, error } = await supabase.from('prompts').select('word').eq('id', promptId).single()
    if (error || !data) return null
    return (data as any).word as string
  }

  function releaseSuppressionAndRefresh() {
    const id = roomIdRef.current
    if (!id) return
    // 5秒表示を終えたので抑止を解除してからリフレッシュ
    suppressUntilRef.current = null
    void refreshRound(id)
  }

  function startTimer(r: Round) {
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null }
    const parsed = r.started_at ? Date.parse(r.started_at) : NaN
    const start = Number.isFinite(parsed) ? parsed : Date.now()
    const total = Number(roundTimeRef.current || 60)
    const initialLeft = Math.max(0, total - Math.floor((Date.now() - start) / 1000))
    setTimeLeft(initialLeft > 0 ? initialLeft : total)
    const t = window.setInterval(async () => {
      const left = Math.max(0, total - Math.floor((Date.now() - start) / 1000))
      setTimeLeft(left)
      if (left <= 0) {
        window.clearInterval(t); timerRef.current = null

        // すでに時間切れ処理や正解処理で進行済みなら何もしない
        if (advancedThisRound) return

        // 時間切れモーダル表示（全員に出す）
        setAdvancedThisRound(true)

        let endedWord = '（取得できませんでした）'
        try {
          const pid = (r as any).prompt_id as string
          const w = await fetchPromptWordById(pid)
          if (w) endedWord = w
        } catch { }

        setMessages(m => [...m, '⏱ 時間切れ — 正解者なし'])
        setOverlayMsg(`制限時間内に正解者はいませんでした。\n正解は『${endedWord}』でした。\n5秒後に次のラウンドが始まります。`)
        setCelebrate(false)
        setOverlayVariant('timeout')
        setOverlayCountdown(5)
        suppressUntilRef.current = Date.now() + 5500

        // 全員：カウントダウンUI
        const countdown = window.setInterval(() => {
          setOverlayCountdown((c) => {
            const v = (c ?? 1) - 1
            if (v <= 0) {
              window.clearInterval(countdown)
            }
            return v
          })
        }, 1000)

        // 5秒後に遷移（ホストだけRPCを叩く。他クライアントはRealtimeで追随）
        window.setTimeout(async () => {
          // まず抑止を解除してから次の処理へ（Realtime/refreshRound が無視されないように）
          suppressUntilRef.current = null

          setOverlayMsg(null)
          setOverlayCountdown(null)

          const id = roomIdRef.current
          if (!id) return

          if (isHostRef.current) {
            try {
              const { error } = await supabase.rpc('advance_round', { p_room_id: id })
              if (error) {
                setMessages(m => [...m, `進行エラー: ${error.message}`])
                try {
                  const token = (await supabase.auth.getSession()).data.session?.access_token
                  await supabase.functions.invoke('advance-round', {
                    body: { roomId: id },
                    headers: token ? { Authorization: `Bearer ${token}` } : undefined
                  })
                } catch { }
              } else {
                setMessages(m => [...m, '次のラウンドへ進行しました'])
              }
            } catch { }
          }

          // 全員：明示リフレッシュ（解除済みなので反映される）
          void refreshRound(id)
        }, 5000)

      }


    }, 500)
    timerRef.current = t
  }
  useEffect(() => { return () => { if (timerRef.current) window.clearInterval(timerRef.current) } }, [])

  const channelName = useMemo(() => room ? `room:${room.id}` : 'room:unknown', [room?.id])

  async function startGame() {
    if (!room) return
    const token = (await supabase.auth.getSession()).data.session?.access_token
    const { error } = await supabase.functions.invoke('start-game', { body: { roomId: room.id }, headers: token ? { Authorization: `Bearer ${token}` } : undefined })
    if (error) setMessages(m => [...m, `開始エラー: ${error.message}`])
  }

  // もう一度遊ぶ（ホストのみ表示するボタンから呼ばれる）
  async function replayGame() {
    if (!room) return
    const token = (await supabase.auth.getSession()).data.session?.access_token
    const { error } = await supabase.functions.invoke('start-game', {
      body: { roomId: room.id },
      headers: token ? { Authorization: `Bearer ${token}` } : undefined
    })
    if (error) {
      setMessages(m => [...m, `再開エラー: ${error.message}`])
    } else {
      setMessages(m => [...m, `🔁 新しいゲームを開始しました`])
      // 次ゲーム用に状態をリセット
      setOverlayMsg(null); setOverlayCountdown(null)
      setAdvancedThisRound(false)
      setRoundSnapshots([])
      lastRoundRef.current = undefined
      await refreshRound(room.id)
      await refreshScores(room.id)
    }
  }

  async function applySettingsAndReplay() {
    if (!room) return
    if (isHost) {
      const { error } = await supabase
        .from('rooms')
        .update({ rounds_total: nextRoundsTotal, round_time_sec: nextRoundTimeSec })
        .eq('id', room.id)
      if (error) {
        setMessages(m => [...m, `設定更新エラー: ${error.message}`])
        return
      }
      // 反映遅延に備えてローカル状態とタイマー参照を即時更新
      setRoom(prev => prev ? { ...prev, rounds_total: nextRoundsTotal, round_time_sec: nextRoundTimeSec } : prev)
      roundTimeRef.current = nextRoundTimeSec
    }
    await replayGame()
  }

  // スコア集計（メンバーにスコア0も含め、降順ソート）
  const sortedScores = useMemo(() => {
    const arr = members.map(m => ({
      id: (m as any).id as string,
      username: m.username,
      points: typeof scores[(m as any).id] === 'number' ? scores[(m as any).id] : 0
    }))
    arr.sort((a, b) => b.points - a.points || a.username.localeCompare(b.username))
    return arr
  }, [members, scores])

  const isGameFinished = room?.status === 'finished'
  const isFinished = isGameFinished && showResult

  useEffect(() => {
    if (!isFinished) return
    if (historySavedRef.current) return
    void saveGameHistory()
  }, [isFinished])

  async function endGame() {
    if (!room) return
    const token = (await supabase.auth.getSession()).data.session?.access_token
    const { error } = await supabase.functions.invoke('end-game', { body: { roomId: room.id }, headers: token ? { Authorization: `Bearer ${token}` } : undefined })
    if (error) setMessages(m => [...m, `終了エラー: ${error.message}`])
    else window.location.href = '/'
  }

  async function saveGameHistory() {
    if (historySavedRef.current) return
    const roomId = roomIdRef.current
    if (!roomId || !room) return
    const { data: userData } = await supabase.auth.getUser()
    const user = userData.user
    if (!user || user.is_anonymous) return
    const { data: sessionData } = await supabase.auth.getSession()
    const session = sessionData.session
    console.info('[history] save start', {
      roomId,
      roomName: room.name,
      hostUserId: room.host_user,
      userId: user.id,
      isAnonymous: user.is_anonymous,
      sessionUserId: session?.user?.id ?? null,
      hasAccessToken: !!session?.access_token,
    })
    const { data: roomRow, error: roomError } = await supabase
      .from('rooms')
      .select('id,host_user,status')
      .eq('id', roomId)
      .maybeSingle()
    console.info('[history] room check', {
      roomId,
      room: roomRow ?? null,
      error: roomError?.message ?? null,
    })
    const { data: profileRow, error: profileError } = await supabase
      .from('profiles')
      .select('username')
      .eq('user_id', user.id)
      .maybeSingle()
    console.info('[history] profile check', {
      userId: user.id,
      username: (profileRow as any)?.username ?? null,
      error: profileError?.message ?? null,
    })
    const { data: debugRow, error: debugError } = await supabase
      .rpc('debug_history_policy', { p_room_id: roomId })
    console.info('[history] policy debug', {
      data: debugRow ?? null,
      error: debugError?.message ?? null,
    })
    if (debugRow) {
      console.info('[history] policy debug raw', JSON.stringify(debugRow))
    }
    historySavedRef.current = true
    try {
      const { data: roundRows } = await supabase
        .from('rounds')
        .select('id,number,prompt_id,drawer_member_id,started_at,ended_at')
        .eq('room_id', roomId)
      const rounds = (roundRows as any[]) || []
      const startedAt = rounds
        .map(r => r.started_at)
        .filter(Boolean)
        .sort()[0] ?? new Date().toISOString()
      const endedAt = rounds
        .map(r => r.ended_at)
        .filter(Boolean)
        .sort()
        .slice(-1)[0] ?? new Date().toISOString()

      const { data: sessionId, error: sessionError } = await supabase
        .rpc('upsert_game_session', {
          p_room_id: roomId,
          p_room_name: room.name,
          p_host_user_id: room.host_user,
          p_rounds_total: room.rounds_total,
          p_round_time_sec: room.round_time_sec,
          p_started_at: startedAt,
          p_ended_at: endedAt,
        })
      if (sessionError || !sessionId) {
        console.error('[history] game_sessions upsert failed', {
          roomId,
          userId: user.id,
          hostUserId: room.host_user,
          message: sessionError?.message,
          details: sessionError?.details,
          hint: sessionError?.hint,
          code: sessionError?.code,
        })
        historySavedRef.current = false
        const msg = sessionError?.message ? `履歴の保存に失敗しました: ${sessionError.message}` : '履歴の保存に失敗しました。'
        setMessages(m => [...m, msg])
        return
      }
      const sessionIdStr = sessionId as string

      const { data: memberRows } = await supabase
        .from('room_members')
        .select('id,user_id,username,is_host,joined_at,left_at')
        .eq('room_id', roomId)
      const membersData = (memberRows as any[]) || []
      const memberMatch = membersData.find(m => m.user_id === user.id)
      console.info('[history] room_members', {
        count: membersData.length,
        hasSelf: !!memberMatch,
        selfMemberId: memberMatch?.id ?? null,
      })
      const memberById = new Map(membersData.map(m => [m.id as string, m]))

      const participants = membersData.map(m => ({
        session_id: sessionIdStr,
        user_id: m.user_id,
        username_at_time: m.username,
        is_host: m.is_host,
        score: typeof scores[m.id as string] === 'number' ? scores[m.id as string] : 0,
        joined_at: m.joined_at,
        left_at: m.left_at,
      }))
      if (participants.length > 0) {
        const { error: participantsError } = await supabase
          .rpc('upsert_game_participants', { p_rows: participants })
        if (participantsError) {
          historySavedRef.current = false
          setMessages(m => [...m, `履歴の保存に失敗しました: ${participantsError.message}`])
          return
        }
      }

      const promptIds = Array.from(new Set(rounds.map(r => r.prompt_id).filter(Boolean)))
      const { data: promptRows } = promptIds.length > 0
        ? await supabase.from('prompts').select('id,word').in('id', promptIds as string[])
        : { data: [] as any[] }
      const promptWordById = new Map((promptRows as any[]).map(p => [p.id as string, p.word as string]))

      const { data: guessRows } = await supabase
        .from('guesses')
        .select('round_id,member_id,created_at,content')
        .eq('room_id', roomId)
        .eq('is_correct', true)
        .order('created_at', { ascending: true })
      const winnerByRound = new Map<string, { member_id: string; content: string }>()
      for (const g of (guessRows as any[]) || []) {
        if (!winnerByRound.has(g.round_id)) {
          winnerByRound.set(g.round_id, { member_id: g.member_id, content: g.content })
        }
      }

      const snapshots = roundSnapshotsRef.current
      const snapshotRows = snapshots.map(s => {
        const roundRow = rounds.find(r => r.id === s.roundId)
        if (!roundRow) return null
        const drawerMember = memberById.get(roundRow.drawer_member_id)
        const winner = winnerByRound.get(roundRow.id)
        const winnerMember = winner ? memberById.get(winner.member_id) : null
        const promptWord = promptWordById.get(roundRow.prompt_id) ?? s.promptWord ?? '不明'
        return {
          session_id: sessionIdStr,
          round_number: roundRow.number,
          drawer_user_id: drawerMember?.user_id ?? null,
          prompt_id: roundRow.prompt_id,
          prompt_word: promptWord,
          image_url: s.dataUrl,
          correct_user_id: winnerMember?.user_id ?? null,
          correct_answer: winner?.content ?? null,
        }
      }).filter(Boolean) as any[]

      if (snapshotRows.length > 0) {
        const { error: snapshotError } = await supabase
          .rpc('upsert_round_snapshots', { p_rows: snapshotRows })
        if (snapshotError) {
          historySavedRef.current = false
          setMessages(m => [...m, `履歴の保存に失敗しました: ${snapshotError.message}`])
          return
        }
      }
    } catch (e) {
      historySavedRef.current = false
      setMessages(m => [...m, '履歴の保存に失敗しました。'])
    }
  }

  async function leaveRoom() {
    if (!room || !memberId) return
    await supabase.from('room_members').delete().eq('id', memberId)
    window.location.href = '/'
  }

  async function submitGuess() {
    if (!room || !activeRound || !memberId || !guess.trim()) return
    const { error } = await supabase.from('guesses').insert({ room_id: room.id, round_id: activeRound.id, member_id: memberId, content: guess.trim() })
    if (error) setMessages(m => [...m, `回答エラー: ${error.message}`])
    setGuess('')
  }

  if (!ready) return <main className='container'>読み込み中…</main>
  if (!room) return <main className='container'>部屋を読み込み中…</main>
  if (!memberId) return <main className='container'>入室エラー: トップから参加してください。</main>

  const amDrawer = !!drawerMemberId && (memberId === drawerMemberId)

  return (
    <main className='container grid' style={{ gap: 16 }}>
      <div className='panelHeader'>
        <div>
          <div className='title'>部屋: {room.name}</div>
          <div className='subtitle'></div>
          <div className='hstack'><span className='badge'>あなたは {(drawerMemberId === memberId) ? '出題者' : '回答者'}</span></div>
        </div>
        <div className='hstack'>
          {!isHost && <button className='button ghost' onClick={leaveRoom}>部屋から退室する</button>}
          {isHost && room.status === 'lobby' && (
            <>
              <button className='button' onClick={startGame}>ゲーム開始</button>
              <button className='button ghost' onClick={endGame}>部屋を破棄する</button>
            </>
          )}
          {isHost && room.status === 'in_progress' && <button className='button' onClick={endGame}>ゲームを終了する</button>}
          {isHost && isFinished && (
            <>
              <button className='button' onClick={applySettingsAndReplay}>もう一度遊ぶ</button>
              <button className='button ghost' onClick={endGame}>部屋を閉じる</button>
            </>
          )}
        </div>
      </div>

      {!isFinished && (
        <section className='row' style={{ alignItems: 'flex-start' }}>
          <div className='card' style={{ flex: 1, minWidth: 320 }}>
            <h3>{amDrawer ? 'あなたは出題者です ✏️' : 'あなたは回答者です 💬'}</h3>
            {amDrawer ? (
              <p className='subtitle'>
                お題: <strong>{promptWord ?? '準備中…'}</strong>{' ／ カテゴリ: '}
                <strong>{promptCategory ?? '未設定'}</strong>
              </p>
            ) : (
              <p className='subtitle'>お題の文字数: <strong>{promptLen}</strong>{' ／ カテゴリ: '}<strong>{promptCategory ?? '未設定'}</strong></p>
            )}
            <div className='canvasWrap' style={{ position: 'relative' }}>
              <CanvasBoard ref={canvasRef} key={activeRound?.id} roomId={room.id} enabled={amDrawer} channelName={channelName} />
              {overlayMsg && (
                <div className='overlayBackdrop'>
                  {overlayVariant === 'correct' && <div className='overlayDoubleCircle' aria-hidden />}
                  {overlayVariant === 'timeout' && <div className='overlayCross' aria-hidden />}
                  <div className='overlayCard'>
                    <div className='overlayTitle'>{overlayMsg}</div>
                    {typeof overlayCountdown === 'number' && overlayCountdown >= 0 && (
                      <div className='overlayCountdown'>次のラウンドまで: {overlayCountdown}s</div>
                    )}
                  </div>
                </div>
              )}
              {/* Flowing comments layer */}
              <div ref={flyLayerRef} className='flyLayer' aria-hidden>
                {flyItems.map(it => (
                  <div
                    key={it.id}
                    className='flyItem'
                    style={{ top: it.top }}
                    ref={(el) => {
                      if (!el) return
                      const layer = flyLayerRef.current
                      const layerW = layer?.clientWidth ?? 600
                      const selfW = el.offsetWidth
                      // place offscreen to the right by its width
                      el.style.setProperty('--start', `${selfW + 12}px`)
                      // compute duration from distance / speed
                      const distPx = layerW + selfW + 48
                      const durSec = Math.max(2, distPx / flySpeedPxPerSec)
                      el.style.setProperty('--dur', `${durSec}s`)
                      // kick off transition next frame
                      requestAnimationFrame(() => {
                        el.style.transform = `translateX(-${distPx}px)`
                      })
                      // schedule removal after it fully exits
                      window.setTimeout(() => {
                        setFlyItems(items => items.filter(x => x.id !== it.id))
                      }, durSec * 1000 + 200)
                    }}
                  >{it.text}</div>
                ))}
              </div>
            </div>
          </div>
          <div className='card' style={{ width: 360 }}>
            <div className='grid' style={{ gap: 8 }}>
              <div className='hstack'><span className='badge'>ラウンド</span><strong>{activeRound ? `${activeRound.number}/${room.rounds_total}` : '—'}</strong></div>
              <div className='hstack'><span className='badge'>残り時間</span><strong className='timer'>{timeLeft}s</strong></div>
              <div>
                <h4>参加者</h4>
                <ul>
                  {members.map(m => <li key={m.id as any}>{m.username}{(m as any).id === drawerMemberId ? ' ✏️' : ''}{m.is_host ? ' (ホスト)' : ''} {typeof (scores as any)[(m as any).id] === 'number' ? ` — ${scores[(m as any).id]}点` : ''}</li>)}
                </ul>
              </div>
              <div>
                <h4>回答</h4>
                {amDrawer ? (
                  <p className='subtitle'>あなたは出題者です。回答は入力できません。</p>
                ) : (
                  <>
                    <p className='subtitle'>ひらがなで入力してね！</p>
                    <div className='row'>
                      <input className='input' value={guess} onChange={(e) => setGuess(e.target.value)} placeholder='回答を入力…' onKeyDown={(e) => { if (e.key === 'Enter') submitGuess() }} />
                      <button className='button' onClick={submitGuess}>送信</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* リザルト画面 */}
      {isFinished && (
        <section className='card'>
          <h3>リザルト / スコアボード</h3>
          <p className='subtitle'>総合順位とスコアを表示します。</p>
          <ol>
            {sortedScores.map((s, idx) => (
              <li key={s.id}>
                <strong>{idx + 1}位:</strong> {s.username} — <strong>{s.points}点</strong>
                {members.find(m => (m as any).id === s.id)?.is_host ? ' (ホスト)' : ''}
              </li>
            ))}
          </ol>
          <div className='grid' style={{ marginTop: 16 }}>
            <h4>各ラウンドの絵</h4>
            {roundSnapshots.length === 0 ? (
              <p className='subtitle'>ラウンド絵の記録はまだありません。</p>
            ) : (
              <div className='grid' style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                {[...roundSnapshots]
                  .sort((a, b) => a.roundNumber - b.roundNumber)
                  .map(s => (
                    <div key={s.roundId} className='card' style={{ padding: 8, background: '#ffffff', color: '#222' }}>
                      <img src={s.dataUrl} alt={`ラウンド${s.roundNumber}の絵`} style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 6, border: '1px solid #ddd' }} />
                      <div className='subtitle' style={{ marginTop: 6 }}>
                        ラウンド {s.roundNumber}{s.drawerName ? ` — 出題者: ${s.drawerName}` : ''}
                      </div>
                      <div className='subtitle'>
                        お題: {s.promptWord ?? '不明'}
                      </div>
                      <div className='subtitle'>
                        正解者: {s.winnerName ?? 'なし'}
                      </div>
                      <div className='subtitle'>
                        経過: {typeof s.durationSec === 'number' ? `${s.durationSec}s` : '不明'}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
          {isHost && (
            <div className='grid' style={{ marginTop: 16 }}>
              <h4>次のゲーム設定</h4>
              <div className='row'>
                <label className='label'>
                  ラウンド数
                  <select className='input' value={nextRoundsTotal} onChange={(e) => setNextRoundsTotal(Number(e.target.value))}>
                    {Array.from({ length: 20 }, (_, i) => i + 1).map(n => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label className='label'>
                  制限時間
                  <select className='input' value={nextRoundTimeSec} onChange={(e) => setNextRoundTimeSec(Number(e.target.value))}>
                    {[60, 120, 180, 240, 300].map(sec => (
                      <option key={sec} value={sec}>{sec / 60}分</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className='row'>
                <button className='button' onClick={applySettingsAndReplay}>設定してもう一度遊ぶ</button>
              </div>
            </div>
          )}
          {!isHost && <p className='subtitle'>ホストの「もう一度遊ぶ」でゲームが再開されます。</p>}
        </section>
      )}

      <section className='card'>
        <h3>回答ログ</h3>
        <ul>
          {messages.map((m, i) => (<li key={i}>{m}</li>))}
        </ul>
      </section>
    </main>
  )
}
