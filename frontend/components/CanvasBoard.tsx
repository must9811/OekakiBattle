'use client'
import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

type Props = {
  roomId: string
  enabled: boolean
  channelName?: string
}

export default function CanvasBoard({ roomId, enabled, channelName }: Props){
  const canvasRef = useRef<HTMLCanvasElement|null>(null)
  const drawingRef = useRef(false)
  const lastPos = useRef<{x:number,y:number}|null>(null)
  const [size, setSize] = useState<{w:number;h:number}>({ w: 600, h: 400 })
  const chanRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const [color, setColor] = useState('#222222')
  const [width, setWidth] = useState(3)
  const [mode, setMode] = useState<'pen'|'erase'>('pen')
  const strokesRef = useRef<Array<{x1:number,y1:number,x2:number,y2:number,color:string,width:number}>>([])
  const strokeStartIdxRef = useRef<number[]>([])

  useEffect(()=>{
    const onResize = () => {
      const el = canvasRef.current?.parentElement
      if (!el) return
      const w = Math.max(320, el.clientWidth)
      const h = Math.max(240, Math.round(w * 2/3))
      setSize({ w, h })
    }
    onResize()
    window.addEventListener('resize', onResize)
    return ()=> window.removeEventListener('resize', onResize)
  }, [])

  useEffect(()=>{
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    // crisp lines
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 3
    ctx.strokeStyle = '#222'
  }, [size])

  const drawSegment = (x1:number, y1:number, x2:number, y2:number, color='#222', width=3) => {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }

  const replay = () => {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    ctx.clearRect(0,0,c.width,c.height)
    for (const s of strokesRef.current) drawSegment(s.x1,s.y1,s.x2,s.y2,s.color,s.width)
  }

  const start = (x:number, y:number) => {
    if (!enabled) return
    drawingRef.current = true
    strokeStartIdxRef.current.push(strokesRef.current.length)
    lastPos.current = { x, y }
  }
  const move = (x:number, y:number) => {
    if (!enabled) return
    if (!drawingRef.current) return
    const lp = lastPos.current || { x, y }
    const stroke = {
      x1: lp.x, y1: lp.y, x2: x, y2: y,
      color: mode==='erase' ? '#ffffff' : color,
      width: mode==='erase' ? Math.max(8, width) : width,
    }
    strokesRef.current.push(stroke)
    drawSegment(stroke.x1, stroke.y1, stroke.x2, stroke.y2, stroke.color, stroke.width)
    // broadcast stroke
    if (chanRef.current) {
      chanRef.current.send({ type: 'broadcast', event: 'stroke', payload: stroke })
    }
    lastPos.current = { x, y }
  }
  const end = () => {
    drawingRef.current = false
    lastPos.current = null
  }

  const onPointerDown: React.PointerEventHandler<HTMLCanvasElement> = (e) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    start(e.clientX - rect.left, e.clientY - rect.top)
  }
  const onPointerMove: React.PointerEventHandler<HTMLCanvasElement> = (e) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    move(e.clientX - rect.left, e.clientY - rect.top)
  }
  const onPointerUp: React.PointerEventHandler<HTMLCanvasElement> = () => end()
  const onPointerLeave: React.PointerEventHandler<HTMLCanvasElement> = () => end()

  // Setup realtime drawing channel
  useEffect(()=>{
    if (!channelName) return
    const ch = supabase.channel(channelName, { config: { broadcast: { self: true } } })
      .on('broadcast', { event: 'stroke' }, ({ payload }) => {
        const { x1, y1, x2, y2, color, width } = payload as any
        strokesRef.current.push({ x1,y1,x2,y2,color,width })
        drawSegment(x1, y1, x2, y2, color, width)
      })
      .on('broadcast', { event: 'undo' }, ({ payload }) => {
        const count = Math.max(1, Number((payload as any)?.count ?? 1))
        const newLen = Math.max(0, strokesRef.current.length - count)
        strokesRef.current.splice(newLen)
        replay()
      })
      .on('broadcast', { event: 'clear' }, () => {
        strokesRef.current = []
        strokeStartIdxRef.current = []
        replay()
      })
      .subscribe()
    chanRef.current = ch
    return () => { ch.unsubscribe(); chanRef.current = null }
  }, [channelName])

  const onUndo = () => {
    if (!enabled) return
    const startIdx = strokeStartIdxRef.current.pop()
    if (startIdx === undefined) return
    const count = Math.max(0, strokesRef.current.length - startIdx)
    if (count <= 0) return
    strokesRef.current.splice(startIdx)
    replay()
    chanRef.current?.send({ type:'broadcast', event:'undo', payload:{ count } })
  }
  const onClear = () => {
    if (!enabled) return
    strokesRef.current = []
    strokeStartIdxRef.current = []
    replay()
    chanRef.current?.send({ type:'broadcast', event:'clear', payload:{} })
  }

  return (
    <div className='canvas' style={{ position:'relative' }}>
      {enabled && (
        <div className='row' style={{ gap:8, marginBottom:8 }}>
          <label className='label'>色<input className='input' type='color' value={color} onChange={e=>setColor(e.target.value)} /></label>
          <label className='label'>太さ<input className='input' type='range' min={1} max={20} value={width} onChange={e=>setWidth(Number(e.target.value))} /></label>
          <button className='button' onClick={()=>setMode('pen')}>ペン</button>
          <button className='button' onClick={()=>setMode('erase')}>消しゴム</button>
          <button className='button' onClick={onClear}>クリア</button>
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={size.w}
        height={size.h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        style={{ touchAction:'none', background:'#fff', border:'1px solid #ddd', borderRadius:8 }}
      />
      {!enabled && (
        <div style={{ position:'absolute', inset:0, background:'transparent' }} aria-hidden />
      )}
    </div>
  )
}

