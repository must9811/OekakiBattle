'use client'
import Link from 'next/link'
import { FormEvent, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { useAnonAuth } from '@/lib/useAnonAuth'

export default function HomePage() {
  const ready = useAnonAuth()
  const [mode, setMode] = useState<'none'|'create'|'join'>('none')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [rounds, setRounds] = useState(3)
  const [roundTime, setRoundTime] = useState(60)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(undefined)
    setLoading(true)
    try {
      const session = (await supabase.auth.getSession()).data.session
      if (!session?.access_token) throw new Error('auth not ready')
      const token = session.access_token

      if (mode === 'create') {
        const { data, error } = await supabase.functions.invoke('create-room', {
          body: { name, password, username, roundsTotal: rounds, roundTimeSec: roundTime },
          headers: { Authorization: `Bearer ${token}` },
        })
        if (error) throw new Error(error.message)
        if (!data?.room?.room_id) throw new Error('unexpected')
      } else if (mode === 'join') {
        const { data, error } = await supabase.functions.invoke('join-room', {
          body: { name, password, username },
          headers: { Authorization: `Bearer ${token}` },
        })
        if (error) throw new Error(error.message)
      }
      window.location.href = `/room/${encodeURIComponent(name)}`
    } catch (e: any) {
      const msg = e?.message || 'error'
      const friendly = msg.includes('room_name_taken') || msg.includes('duplicate key')
        ? 'その部屋名は既に使われています。別の名前にしてください。'
        : msg
      setError(friendly)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className='container grid' style={{ gap: 16 }}>
      <h1 className='title'>オンラインお絵描きあてバトル</h1>
      {!ready && <p className='subtitle'>サインイン準備中…</p>}
      {ready && (
        <>
          {mode === 'none' && (
            <div className='row' style={{ gap: 12 }}>
              <button className='button' onClick={()=>setMode('create')}>部屋を作成する</button>
              <button className='button ghost' onClick={()=>setMode('join')}>部屋に入室する</button>
            </div>
          )}

          {mode !== 'none' && (
            <div className='card' style={{ maxWidth: 520 }}>
              <div className='panelHeader'>
                <strong>{mode==='create'?'部屋を作成':'部屋に入室'}</strong>
                <button className='button ghost' onClick={()=>setMode('none')}>戻る</button>
              </div>
              <form onSubmit={onSubmit} className='grid' style={{ gap: 10, marginTop: 12 }}>
                <label className='label'>部屋名
                  <input className='input' value={name} onChange={(e)=>setName(e.target.value)} required minLength={2} maxLength={24} />
                </label>
                <label className='label'>パスワード
                  <input className='input' value={password} onChange={(e)=>setPassword(e.target.value)} required minLength={4} maxLength={16} type='password' />
                </label>
                <label className='label'>ユーザー名
                  <input className='input' value={username} onChange={(e)=>setUsername(e.target.value)} required minLength={1} maxLength={16} />
                </label>
                {mode==='create' && (
                  <div className='row'>
                    <label className='label'>ラウンド数
                      <input className='input' type='number' min={1} max={10} value={rounds} onChange={(e)=>setRounds(Number(e.target.value))} />
                    </label>
                    <label className='label'>制限時間（秒）
                      <select className='input' value={roundTime} onChange={(e)=>setRoundTime(Number(e.target.value))}>
                        <option value={30}>30</option>
                        <option value={60}>60</option>
                        <option value={90}>90</option>
                        <option value={120}>120</option>
                      </select>
                    </label>
                  </div>
                )}
                <div className='row'>
                  <button className='button' type='submit' disabled={loading}>{loading?'送信中…':(mode==='create'?'作成して入室':'入室する')}</button>
                  {error && <span style={{ color:'#ff6b6b' }}>{error}</span>}
                </div>
                <div className='subtitle'>デモURL: <Link href='/room/demo'>/room/demo</Link></div>
              </form>
            </div>
          )}
        </>
      )}
    </main>
  )
}