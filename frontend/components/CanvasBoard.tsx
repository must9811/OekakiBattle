'use client'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

type Props = {
  roomId: string
  enabled: boolean
  channelName?: string
}

export type CanvasBoardHandle = {
  getSnapshotDataUrl: () => string | null
}

const CanvasBoard = forwardRef<CanvasBoardHandle, Props>(function CanvasBoard(
  { roomId, enabled, channelName },
  ref
){
  const canvasRef = useRef<HTMLCanvasElement|null>(null)
  const drawingRef = useRef(false)
  const lastPos = useRef<{x:number,y:number}|null>(null)
  const [size, setSize] = useState<{w:number;h:number}>({ w: 600, h: 400 })
  const chanRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const [color, setColor] = useState('#222222')
  const [width, setWidth] = useState(3)
  const [mode, setMode] = useState<'pen'|'erase'>('pen')
  const [isMobile, setIsMobile] = useState(false)
  const [colorPickerOpen, setColorPickerOpen] = useState(false)
  const [widthPickerOpen, setWidthPickerOpen] = useState(false)
  const strokesRef = useRef<Array<{x1n:number,y1n:number,x2n:number,y2n:number,color:string,widthN:number}>>([])
  const strokeStartIdxRef = useRef<number[]>([])

  useImperativeHandle(ref, () => ({
    getSnapshotDataUrl: () => {
      const c = canvasRef.current
      if (!c) return null
      return c.toDataURL('image/png')
    }
  }), [])

  useEffect(()=>{
    const onResize = () => {
      const el = canvasRef.current?.parentElement
      if (!el) return
      const w = Math.max(240, el.clientWidth)
      const h = Math.max(200, Math.round(w * 2/3))
      setSize({ w, h })
    }
    onResize()
    window.addEventListener('resize', onResize)
    return ()=> window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)')
    const apply = () => setIsMobile(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
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
    replay()
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

  const drawNormalizedStroke = (stroke: {x1n:number,y1n:number,x2n:number,y2n:number,color:string,widthN:number}) => {
    const c = canvasRef.current
    if (!c) return
    const widthPx = Math.max(1, stroke.widthN * c.width)
    drawSegment(
      stroke.x1n * c.width,
      stroke.y1n * c.height,
      stroke.x2n * c.width,
      stroke.y2n * c.height,
      stroke.color,
      widthPx
    )
  }

  const replay = () => {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    ctx.clearRect(0,0,c.width,c.height)
    for (const s of strokesRef.current) drawNormalizedStroke(s)
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
    const c = canvasRef.current
    if (!c) return
    const widthPx = mode==='erase' ? Math.max(8, width) : width
    const stroke = {
      x1n: lp.x / c.width,
      y1n: lp.y / c.height,
      x2n: x / c.width,
      y2n: y / c.height,
      color: mode==='erase' ? '#ffffff' : color,
      widthN: widthPx / c.width,
    }
    strokesRef.current.push(stroke)
    drawNormalizedStroke(stroke)
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
        const p = payload as any
        if (typeof p?.x1n === 'number') {
          const stroke = {
            x1n: p.x1n,
            y1n: p.y1n,
            x2n: p.x2n,
            y2n: p.y2n,
            color: p.color,
            widthN: p.widthN,
          }
          strokesRef.current.push(stroke)
          drawNormalizedStroke(stroke)
          return
        }
        if (typeof p?.x1 === 'number') {
          const c = canvasRef.current
          if (!c) return
          const stroke = {
            x1n: p.x1 / c.width,
            y1n: p.y1 / c.height,
            x2n: p.x2 / c.width,
            y2n: p.y2 / c.height,
            color: p.color,
            widthN: p.width / c.width,
          }
          strokesRef.current.push(stroke)
          drawNormalizedStroke(stroke)
        }
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

  const palette = [
    '#111827',
    '#ef4444',
    '#f97316',
    '#eab308',
    '#22c55e',
    '#14b8a6',
    '#3b82f6',
    '#8b5cf6',
    '#ec4899',
    '#ffffff',
  ]
  const widths = [2, 4, 6, 10, 14]

  return (
    <div className='canvas' style={{ position:'relative' }}>
      {enabled && !isMobile && (
        <div className='grid' style={{ gap:8, marginBottom:8 }}>
          <div className='row' style={{ gap:8, alignItems:'center' }}>
            <span style={{ fontWeight:700, color:'#111827' }}>ペンの色</span>
            {palette.map((c) => (
              <button
                key={c}
                type='button'
                className='button ghost'
                aria-label={`色 ${c}`}
                onClick={() => setColor(c)}
                style={{
                  width:24,
                  height:24,
                  padding:0,
                  borderRadius:6,
                  border: color === c ? '2px solid #111827' : '1px solid rgba(15,23,42,.15)',
                  background: c,
                  boxShadow: c === '#ffffff' ? 'inset 0 0 0 1px rgba(0,0,0,.15)' : 'none'
                }}
              />
            ))}
          </div>
          <div className='row' style={{ gap:8, alignItems:'center', justifyContent:'space-between' }}>
            <div className='row' style={{ gap:8, alignItems:'center' }}>
              <span style={{ fontWeight:700, color:'#111827' }}>ペンの太さ</span>
              {widths.map((w) => {
                const size = Math.round(4 + w * 1.2)
                return (
                  <button
                    key={w}
                    type='button'
                    className='button ghost'
                    aria-label={`太さ ${w}`}
                    onClick={() => setWidth(w)}
                    style={{
                      width:28,
                      height:28,
                      padding:0,
                      borderRadius:999,
                      borderColor: width === w ? 'rgba(15,118,110,.6)' : 'rgba(15,23,42,.15)',
                      background: width === w ? 'rgba(15,118,110,.08)' : 'transparent',
                      display:'grid',
                      placeItems:'center'
                    }}
                  >
                    <span style={{
                      width:size,
                      height:size,
                      borderRadius:999,
                      background:'#111827',
                      display:'block'
                    }} />
                  </button>
                )
              })}
            </div>
            <div className='row' style={{ gap:6 }}>
              <button
                className='button ghost'
                aria-label='ペン'
                onClick={()=>setMode('pen')}
                style={{
                  borderColor: mode === 'pen' ? 'rgba(15,118,110,.6)' : 'rgba(15,23,42,.15)',
                  background: mode === 'pen' ? 'rgba(15,118,110,.12)' : 'transparent'
                }}
              >
                <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke={mode === 'pen' ? '#0f766e' : '#475569'} strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
                  <path d='M12 20h9' />
                  <path d='M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z' />
                </svg>
              </button>
              <button
                className='button ghost'
                aria-label='消しゴム'
                onClick={()=>setMode('erase')}
                style={{
                  borderColor: mode === 'erase' ? 'rgba(15,118,110,.6)' : 'rgba(15,23,42,.15)',
                  background: mode === 'erase' ? 'rgba(15,118,110,.12)' : 'transparent'
                }}
              >
                <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke={mode === 'erase' ? '#0f766e' : '#475569'} strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
                  <path d='M20 20H9l-5-5a2.5 2.5 0 0 1 0-3.5l7-7a2.5 2.5 0 0 1 3.5 0l5.5 5.5a2.5 2.5 0 0 1 0 3.5L14 20z' />
                  <path d='M6 13l5 5' />
                </svg>
              </button>
              <button className='button' onClick={onClear}>クリア</button>
            </div>
          </div>
        </div>
      )}
      {enabled && isMobile && (
        <div className='row canvasMobileTools'>
          <button
            className='button ghost canvasMobileTool'
            type='button'
            onClick={() => setColorPickerOpen(true)}
            aria-label='ペン色'
          >
            <span className='canvasMobileLabel'>色</span>
            <span
              aria-hidden
              style={{
                width:24,
                height:24,
                borderRadius:8,
                border: '1px solid rgba(15,23,42,.15)',
                background: color,
                boxShadow: color === '#ffffff' ? 'inset 0 0 0 1px rgba(0,0,0,.15)' : 'none'
              }}
            />
          </button>
          <button
            className='button ghost canvasMobileTool'
            type='button'
            onClick={() => setWidthPickerOpen(true)}
            aria-label='太さ'
          >
            <span className='canvasMobileLabel'>太さ</span>
            <span
              aria-hidden
              style={{
                width:Math.round(4 + width * 1.2),
                height:Math.round(4 + width * 1.2),
                borderRadius:999,
                background:'#111827',
                display:'block'
              }}
            />
          </button>
          <button
            className='button ghost'
            aria-label='消しゴム'
            onClick={() => setMode(mode === 'erase' ? 'pen' : 'erase')}
            style={{
              width:40,
              height:40,
              padding:0,
              borderRadius:10,
              borderColor: mode === 'erase' ? 'rgba(15,118,110,.6)' : 'rgba(15,23,42,.15)',
              background: mode === 'erase' ? 'rgba(15,118,110,.12)' : 'transparent'
            }}
          >
            <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke={mode === 'erase' ? '#0f766e' : '#475569'} strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
              <path d='M20 20H9l-5-5a2.5 2.5 0 0 1 0-3.5l7-7a2.5 2.5 0 0 1 3.5 0l5.5 5.5a2.5 2.5 0 0 1 0 3.5L14 20z' />
              <path d='M6 13l5 5' />
            </svg>
          </button>
          <button className='button canvasMobileClear' onClick={onClear}>クリア</button>
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

      {enabled && isMobile && colorPickerOpen && (
        <div className='modalBackdrop' onClick={() => setColorPickerOpen(false)} role='presentation'>
          <div className='modalCard card' onClick={(e) => e.stopPropagation()}>
            <div className='panelHeader'>
              <strong>ペンの色</strong>
              <button className='button ghost' onClick={() => setColorPickerOpen(false)}>閉じる</button>
            </div>
            <div className='grid' style={{ gap:10, marginTop:12 }}>
              <div className='row' style={{ gap:8, flexWrap:'wrap' }}>
                {palette.map((c) => (
                  <button
                    key={c}
                    type='button'
                    className='button ghost'
                    aria-label={`色 ${c}`}
                    onClick={() => { setColor(c); setColorPickerOpen(false) }}
                    style={{
                      width:36,
                      height:36,
                      padding:0,
                      borderRadius:8,
                      border: color === c ? '2px solid #111827' : '1px solid rgba(15,23,42,.15)',
                      background: c,
                      boxShadow: c === '#ffffff' ? 'inset 0 0 0 1px rgba(0,0,0,.15)' : 'none'
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {enabled && isMobile && widthPickerOpen && (
        <div className='modalBackdrop' onClick={() => setWidthPickerOpen(false)} role='presentation'>
          <div className='modalCard card' onClick={(e) => e.stopPropagation()}>
            <div className='panelHeader'>
              <strong>ペンの太さ</strong>
              <button className='button ghost' onClick={() => setWidthPickerOpen(false)}>閉じる</button>
            </div>
            <div className='grid' style={{ gap:10, marginTop:12 }}>
              <div className='row' style={{ gap:10, flexWrap:'wrap' }}>
                {widths.map((w) => {
                  const size = Math.round(6 + w * 1.4)
                  return (
                    <button
                      key={w}
                      type='button'
                      className='button ghost'
                      aria-label={`太さ ${w}`}
                      onClick={() => { setWidth(w); setWidthPickerOpen(false) }}
                      style={{
                        width:44,
                        height:44,
                        padding:0,
                        borderRadius:12,
                        borderColor: width === w ? 'rgba(15,118,110,.6)' : 'rgba(15,23,42,.15)',
                        background: width === w ? 'rgba(15,118,110,.08)' : 'transparent',
                        display:'grid',
                        placeItems:'center'
                      }}
                    >
                      <span style={{
                        width:size,
                        height:size,
                        borderRadius:999,
                        background:'#111827',
                        display:'block'
                      }} />
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

export default CanvasBoard
