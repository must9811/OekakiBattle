'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { useAnonAuth } from '@/lib/useAnonAuth'
import CanvasBoard from '@/components/CanvasBoard'
import { useParams } from 'next/navigation'

type Room = { id: string; name: string; status: 'lobby'|'in_progress'|'finished'; round_time_sec: number; rounds_total: number; host_user: string }
type Member = { id: string; username: string; is_host: boolean }
type Round = { id: string; room_id: string; number: number; drawer_member_id: string; prompt_id: string; status: 'pending'|'active'|'ended'|'skipped'; started_at: string|null }

export default function RoomPage() {
  const ready = useAnonAuth()
  const params = useParams<{roomName: string}>()
  const roomName = decodeURIComponent(params.roomName)

  const [room, setRoom] = useState<Room|undefined>()
  const [members, setMembers] = useState<Member[]>([])
  const [activeRound, setActiveRound] = useState<Round|undefined>()
  const [memberId, setMemberId] = useState<string|undefined>()
  const [isHost, setIsHost] = useState(false)
  const [drawerMemberId, setDrawerMemberId] = useState<string|undefined>()
  const [guess, setGuess] = useState('')
  const [messages, setMessages] = useState<string[]>([])
  const [promptWord, setPromptWord] = useState<string|null>(null)
  const [promptLen, setPromptLen] = useState<number>(0)
  const [promptCategory, setPromptCategory] = useState<string|null>(null)
  const [timeLeft, setTimeLeft] = useState<number>(0)
  const [overlayMsg, setOverlayMsg] = useState<string|null>(null)
  const [advancedThisRound, setAdvancedThisRound] = useState(false)
  const [overlayCountdown, setOverlayCountdown] = useState<number|null>(null)
  const roomIdRef = useRef<string|null>(null)
  const memberNameByIdRef = useRef<Record<string,string>>({})
  const [finishedAtLeastOnce, setFinishedAtLeastOnce] = useState(false)
  const [scores, setScores] = useState<Record<string, number>>({})
  const isHostRef = useRef(false)
  const roundTimeRef = useRef<number>(60)
  const overlayIntervalRef = useRef<number|null>(null)
  const overlayTimeoutRef = useRef<number|null>(null)
  const suppressUntilRef = useRef<number|null>(null)
  // Flowing comments over canvas (NicoNico-like)
  type FlyItem = { id:number, text:string, top:number }
  const [flyItems, setFlyItems] = useState<FlyItem[]>([])
  const flyNextId = useRef(1)
  const flyLayerRef = useRef<HTMLDivElement|null>(null)
  const flyLaneIdxRef = useRef(0)
  const flyLineHeight = 26 // px
  const flySpeedPxPerSec = 100 // flowing speed
  function addFlyComment(text: string){
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
    let cleanup: (()=>void)|undefined
    ;(async () => {
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
        .on('postgres_changes', { event: '*', schema: 'public', table: 'rounds', filter: `room_id=eq.${roomData.id}` }, async () => {
          const now = Date.now()
          if (suppressUntilRef.current && now < suppressUntilRef.current) return
          await refreshRound(roomData.id)
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomData.id}` }, async (payload) => {
          setRoom(payload.new as any)
          roomIdRef.current = (payload.new as any)?.id ?? roomIdRef.current
          // ステータスが finished になったらメッセージとフラグ
          if ((payload.new as any)?.status === 'finished') {
            setFinishedAtLeastOnce(true)
            setMessages(m => [...m, '🎉 ゲーム終了！リザルトを表示します。'])
            setOverlayMsg(null); setOverlayCountdown(null)
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

  async function refreshMembers(roomId: string){
    const { data } = await supabase.rpc('get_room_members', { p_room_id: roomId })
    if (data) {
      const arr = data as Member[]
      setMembers(arr)
      const map: Record<string,string> = {}
      for (const m of arr) map[(m as any).id] = m.username
      memberNameByIdRef.current = map
    }
  }

  async function refreshRound(roomId: string){
    // 正解モーダルやタイムアウトモーダルの表示中はラウンド更新を抑止
    if (suppressUntilRef.current && Date.now() < suppressUntilRef.current) {
      return
    }

    const { data: aRound } = await supabase
      .from('rounds')
      .select('*')
      .eq('room_id', roomId)
      .eq('status','active')
      .limit(1)
      .maybeSingle()

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
    } else {
      setActiveRound(undefined)
      setDrawerMemberId(undefined)
      setPromptWord(null)
      setPromptLen(0)
      setPromptCategory(null)
      setTimeLeft(0)
    }
  }


  async function refreshPrompt(roomId: string, promptId?: string){
    const res = await supabase.rpc('get_active_prompt', { p_room_id: roomId })
    const p = res.data as any
    if (p){
      setPromptWord(p.prompt)
      setPromptLen(p.length || 0)
      setPromptCategory(p.category)
    }

    // RPCでカテゴリが来ない場合は prompts から補完
    const id = promptId ?? (activeRound as any)?.prompt_id
    if (id){
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

  async function refreshScores(roomId: string){
    const { data, error } = await supabase.from('v_room_scores').select('*').eq('room_id', roomId)
    if (!error && data) {
      const m: Record<string, number> = {}
      for (const r of data as any[]) m[r.member_id] = r.points
      setScores(m)
    }
  }

  const timerRef = useRef<number|null>(null)

    // 指定された prompt_id からお題の文字列を取得（失敗時は null）
    async function fetchPromptWordById(promptId: string): Promise<string|null> {
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

    function startTimer(r: Round){
      if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null }
      const parsed = r.started_at ? Date.parse(r.started_at) : NaN
      const start = Number.isFinite(parsed) ? parsed : Date.now()
      const total = Number(roundTimeRef.current || 60)
      const initialLeft = Math.max(0, total - Math.floor((Date.now()-start)/1000))
      setTimeLeft(initialLeft > 0 ? initialLeft : total)
      const t = window.setInterval(async ()=>{
        const left = Math.max(0, total - Math.floor((Date.now()-start)/1000))
        setTimeLeft(left)
        if (left<=0) {
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
          } catch {}

          setMessages(m=>[...m, '⏱ 時間切れ — 正解者なし'])
          setOverlayMsg(`制限時間内に正解者はいませんでした。\n正解は『${endedWord}』でした。\n5秒後に次のラウンドが始まります。`)
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
                  setMessages(m=>[...m, `進行エラー: ${error.message}`])
                  try {
                    const token = (await supabase.auth.getSession()).data.session?.access_token
                    await supabase.functions.invoke('advance-round', {
                      body: { roomId: id },
                      headers: token ? { Authorization: `Bearer ${token}` } : undefined
                    })
                  } catch {}
                } else {
                  setMessages(m=>[...m, '次のラウンドへ進行しました'])
                }
              } catch {}
            }

            // 全員：明示リフレッシュ（解除済みなので反映される）
            void refreshRound(id)
          }, 5000)

        }


    }, 500)
    timerRef.current = t
  }
  useEffect(()=>{ return ()=> { if (timerRef.current) window.clearInterval(timerRef.current) } },[])

  const channelName = useMemo(()=> room ? `room:${room.id}` : 'room:unknown', [room?.id])

  async function startGame() {
    if (!room) return
    const token = (await supabase.auth.getSession()).data.session?.access_token
    const { error } = await supabase.functions.invoke('start-game', { body: { roomId: room.id }, headers: token? { Authorization: `Bearer ${token}` }: undefined })
    if (error) setMessages(m=>[...m, `開始エラー: ${error.message}`])
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
      setMessages(m=>[...m, `再開エラー: ${error.message}`])
    } else {
      setMessages(m=>[...m, `🔁 新しいゲームを開始しました`])
      // 次ゲーム用に状態をリセット
      setOverlayMsg(null); setOverlayCountdown(null)
      setAdvancedThisRound(false)
      await refreshRound(room.id)
      await refreshScores(room.id)
    }
  }

  // スコア集計（メンバーにスコア0も含め、降順ソート）
  const sortedScores = useMemo(() => {
    const arr = members.map(m => ({
      id: (m as any).id as string,
      username: m.username,
      points: typeof scores[(m as any).id] === 'number' ? scores[(m as any).id] : 0
    }))
    arr.sort((a,b)=> b.points - a.points || a.username.localeCompare(b.username))
    return arr
  }, [members, scores])

  const isFinished = room?.status === 'finished'

  async function endGame(){
    if (!room) return
    const token = (await supabase.auth.getSession()).data.session?.access_token
    const { error } = await supabase.functions.invoke('end-game', { body: { roomId: room.id }, headers: token? { Authorization: `Bearer ${token}` }: undefined })
    if (error) setMessages(m=>[...m, `終了エラー: ${error.message}`])
    else window.location.href = '/'
  }

  async function leaveRoom(){
    if (!room || !memberId) return
    await supabase.from('room_members').delete().eq('id', memberId)
    window.location.href = '/'
  }

  async function submitGuess() {
    if (!room || !activeRound || !memberId || !guess.trim()) return
    const { error } = await supabase.from('guesses').insert({ room_id: room.id, round_id: activeRound.id, member_id: memberId, content: guess.trim() })
    if (error) setMessages(m=>[...m, `回答エラー: ${error.message}`])
    setGuess('')
  }

  if (!ready) return <main className='container'>読み込み中…</main>
  if (!room) return <main className='container'>部屋を読み込み中…</main>
  if (!memberId) return <main className='container'>入室エラー: トップから参加してください。</main>

  const amDrawer = !!drawerMemberId && (memberId === drawerMemberId)

  return (
    <main className='container grid' style={{ gap:16 }}>
      <div className='panelHeader'>
        <div>
          <div className='title'>部屋: {room.name}</div>
          <div className='subtitle'></div>
          <div className='hstack'><span className='badge'>あなたは { (drawerMemberId===memberId) ? '出題者' : '回答者' }</span></div>
        </div>
        <div className='hstack'>
          {!isHost && <button className='button ghost' onClick={leaveRoom}>部屋から退室する</button>}
          {isHost && room.status==='lobby' && (
            <>
              <button className='button' onClick={startGame}>ゲーム開始</button>
              <button className='button ghost' onClick={endGame}>部屋を破棄する</button>
            </>
          )}
          {isHost && room.status==='in_progress' && <button className='button' onClick={endGame}>ゲームを終了する</button>}
          {isHost && isFinished && (
            <>
              <button className='button' onClick={replayGame}>もう一度遊ぶ</button>
              <button className='button ghost' onClick={endGame}>部屋を閉じる</button>
            </>
          )}
        </div>
      </div>

      {!isFinished && (
      <section className='row' style={{ alignItems:'flex-start' }}>
        <div className='card' style={{ flex:1, minWidth:320 }}>
          <h3>お絵描き</h3>
          {amDrawer ? <p className='subtitle'>お題: <strong>{promptWord ?? '準備中…'}</strong></p> : <p className='subtitle'>お題の文字数: <strong>{promptLen}</strong>{' ／ カテゴリ: '}<strong>{promptCategory ?? '未設定'}</strong></p>}
            <div className='canvasWrap' style={{ position:'relative' }}>
              <CanvasBoard key={activeRound?.id} roomId={room.id} enabled={amDrawer} channelName={channelName} />
            {overlayMsg && (
              <div style={{ position:'absolute', inset:0, display:'grid', placeItems:'center', background:'rgba(128,128,128,0.4)' }}>
                <div style={{ width:280, height:280, background:'#ffffff', color:'#222', borderRadius:12, boxShadow:'0 6px 16px rgba(0,0,0,0.2)', display:'grid', alignContent:'center', justifyItems:'center', padding:16, textAlign:'center', whiteSpace:'pre-line' }}>
                  <div style={{ fontSize:18, fontWeight:800 }}>{overlayMsg}</div>
                  {typeof overlayCountdown === 'number' && overlayCountdown >= 0 && (
                    <div style={{ marginTop:12, fontSize:14, color:'#555' }}>次のラウンドまで: {overlayCountdown}s</div>
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
        <div className='card' style={{ width:360 }}>
          <div className='grid' style={{ gap:8 }}>
            <div className='hstack'><span className='badge'>ラウンド</span><strong>{activeRound? `${activeRound.number}/${room.rounds_total}` : '—'}</strong></div>
            <div className='hstack'><span className='badge'>残り時間</span><strong className='timer'>{timeLeft}s</strong></div>
            <div>
              <h4>参加者</h4>
              <ul>
                {members.map(m=> <li key={m.id as any}>{m.username}{(m as any).id===drawerMemberId?' ✏️':''}{m.is_host?' (ホスト)':''} {typeof (scores as any)[(m as any).id] === 'number' ? ` — ${scores[(m as any).id]}点` : ''}</li>)}
              </ul>
            </div>
            <div>
              <h4>回答</h4>
              {amDrawer ? (
                <p className='subtitle'>あなたは出題者です。回答は入力できません。</p>
              ) : (
                <div className='row'>
                  <input className='input' value={guess} onChange={(e)=>setGuess(e.target.value)} placeholder='回答を入力…' onKeyDown={(e)=>{ if (e.key==='Enter') submitGuess() }} />
                  <button className='button' onClick={submitGuess}>送信</button>
                </div>
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
                <strong>{idx+1}位:</strong> {s.username} — <strong>{s.points}点</strong>
                {members.find(m => (m as any).id===s.id)?.is_host ? ' (ホスト)' : ''}
              </li>
            ))}
          </ol>
          {!isHost && <p className='subtitle'>ホストの「もう一度遊ぶ」でゲームが再開されます。</p>}
        </section>
      )}

      <section className='card'>
        <h3>回答ログ</h3>
        <ul>
          {messages.map((m,i)=>(<li key={i}>{m}</li>))}
        </ul>
      </section>
    </main>
  )
}
