import { useState, useEffect, useRef, useCallback } from 'react'

interface MoodBubble {
  id: number
  delta: number
}

interface MoodIndicatorProps {
  language?: 'zh' | 'en'
}

const OPENCLAW_URL = 'http://127.0.0.1:18789'

const BALL_SIZE = 48
const DPR = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1

// 5 tiers: 90+ pink, 70+ orange, 50+ green, 30+ blue, 0+ grey
function moodRGB(percent: number): [number, number, number] {
  if (percent >= 90) return [255, 107, 157]
  if (percent >= 70) return [255, 165, 70]
  if (percent >= 50) return [72, 199, 142]
  if (percent >= 30) return [78, 168, 222]
  return [160, 168, 180]
}

/**
 * Draw a liquid-filled sphere with two bezier-curve wave layers
 * and a subtle glass highlight for 3D depth.
 */
function drawLiquidBall(
  ctx: CanvasRenderingContext2D,
  size: number,
  percent: number,
  t: number,
) {
  const r = size / 2
  const cx = r
  const cy = r
  ctx.clearRect(0, 0, size, size)

  // ── Clip to circle ──
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2)
  ctx.clip()

  // ── Background ──
  ctx.fillStyle = 'rgba(235, 238, 242, 0.9)'
  ctx.fillRect(0, 0, size, size)

  // ── Water level ──
  const waterY = size * (1 - percent / 100)
  const [cr, cg, cb] = moodRGB(percent)

  // Helper: draw a bezier wave path across the circle and fill below
  const drawWave = (
    amplitude: number,
    waveLen: number,
    speed: number,
    phaseOffset: number,
    alpha: number,
  ) => {
    ctx.beginPath()
    const yBase = waterY
    // Start from left edge
    ctx.moveTo(0, yBase)
    const steps = 8
    const stepW = size / steps
    for (let i = 0; i < steps; i++) {
      const x0 = i * stepW
      const x1 = (i + 0.5) * stepW
      const x2 = (i + 1) * stepW
      // Alternating wave peaks using sin for control point offsets
      const cp1y = yBase + Math.sin(t * speed + phaseOffset + i * (Math.PI * 2 / steps) * (size / waveLen)) * amplitude
      const cp2y = yBase + Math.sin(t * speed + phaseOffset + (i + 0.5) * (Math.PI * 2 / steps) * (size / waveLen)) * amplitude
      const ey = yBase + Math.sin(t * speed + phaseOffset + (i + 1) * (Math.PI * 2 / steps) * (size / waveLen)) * amplitude * 0.8
      void x1 // use bezier with two control points
      ctx.bezierCurveTo(x0 + stepW * 0.33, cp1y, x0 + stepW * 0.66, cp2y, x2, ey)
    }
    // Close path at bottom
    ctx.lineTo(size, size)
    ctx.lineTo(0, size)
    ctx.closePath()
    ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha})`
    ctx.fill()
  }

  // Back wave: slower, slightly larger amplitude, lighter
  drawWave(3.5, 40, 1.8, 0, 0.35)
  // Front wave: faster, smaller amplitude, full color
  drawWave(2.5, 32, 2.5, Math.PI * 0.8, 0.85)

  ctx.restore()

  // ── Border ──
  ctx.beginPath()
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2)
  ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.5)`
  ctx.lineWidth = 1.5
  ctx.stroke()

  // ── Glass highlight (top-left specular) ──
  const hlR = r * 0.38
  const hlX = cx - r * 0.25
  const hlY = cy - r * 0.28
  const hlGrad = ctx.createRadialGradient(hlX, hlY, 0, hlX, hlY, hlR)
  hlGrad.addColorStop(0, 'rgba(255,255,255,0.45)')
  hlGrad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.beginPath()
  ctx.arc(hlX, hlY, hlR, 0, Math.PI * 2)
  ctx.fillStyle = hlGrad
  ctx.fill()
}

let bubbleIdCounter = 0

export function MoodIndicator({ language = 'zh' }: MoodIndicatorProps) {
  const tr = (zh: string, en: string) => language === 'en' ? en : zh
  const [mood, setMood] = useState(60)
  const [bubbles, setBubbles] = useState<MoodBubble[]>([])
  const [visible, setVisible] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: window.innerWidth / 2, y: 6 })
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const displayPercentRef = useRef(60)
  const timeRef = useRef(0)

  useEffect(() => {
    fetch(`${OPENCLAW_URL}/plugins/claw-sama/settings`)
      .then((r) => r.json())
      .then((s) => { if (s.moodIndex !== undefined) { setMood(s.moodIndex); displayPercentRef.current = s.moodIndex } })
      .catch(() => {})
  }, [])

  const showBriefly = useCallback(() => {
    setVisible(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setVisible(false), 5000)
  }, [])

  useEffect(() => {
    const es = new EventSource(`${OPENCLAW_URL}/plugins/claw-sama/events`)
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.moodIndex !== undefined && data.moodDelta !== undefined) {
          setMood(data.moodIndex)
          showBriefly()
          const id = ++bubbleIdCounter
          setBubbles((prev) => [...prev, { id, delta: data.moodDelta }])
          setTimeout(() => setBubbles((prev) => prev.filter((b) => b.id !== id)), 2000)
        }
      } catch { /* ignore */ }
    }
    return () => es.close()
  }, [showBriefly])

  // Canvas animation loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = BALL_SIZE * DPR
    canvas.height = BALL_SIZE * DPR
    ctx.scale(DPR, DPR)

    let running = true
    const animate = () => {
      if (!running) return
      const target = Math.max(2, mood)
      displayPercentRef.current += (target - displayPercentRef.current) * 0.08
      timeRef.current += 0.04

      drawLiquidBall(ctx, BALL_SIZE, displayPercentRef.current, timeRef.current)
      animRef.current = requestAnimationFrame(animate)
    }
    animate()
    return () => { running = false; cancelAnimationFrame(animRef.current) }
  }, [mood])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(true)
    setVisible(true)
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }

    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const offsetX = e.clientX - rect.left - rect.width / 2
    const offsetY = e.clientY - rect.top

    const onMove = (ev: PointerEvent) => {
      setPos({ x: ev.clientX - offsetX, y: ev.clientY - offsetY })
    }
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      hideTimerRef.current = setTimeout(() => setVisible(false), 3000)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const handleMouseEnter = useCallback(() => {
    setVisible(true)
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (!dragging) {
      hideTimerRef.current = setTimeout(() => setVisible(false), 2000)
    }
  }, [dragging])

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        top: pos.y,
        left: pos.x,
        transform: 'translateX(-50%)',
        zIndex: 250,
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        transition: 'opacity 0.5s ease',
        opacity: visible || bubbles.length > 0 ? 1 : 0.5,
        cursor: dragging ? 'grabbing' : 'grab',
        userSelect: 'none',
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDown={handlePointerDown}
      data-no-passthrough
    >
      {/* Floating bubbles */}
      <div style={{ position: 'relative', width: BALL_SIZE + 40, height: 20, overflow: 'visible' }}>
        {bubbles.map((b) => (
          <span
            key={b.id}
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 0,
              fontSize: 12,
              fontWeight: 700,
              color: b.delta > 0 ? '#FF6B9D' : '#A0A8B4',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              animation: 'mood-bubble-float 1.8s ease-out forwards',
              fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
              textShadow: '0 1px 4px rgba(0,0,0,0.3)',
            }}
          >
            {tr('心情', 'Mood')}{b.delta > 0 ? `+${b.delta}` : b.delta}
          </span>
        ))}
      </div>

      {/* Liquid ball */}
      <div style={{ position: 'relative', width: BALL_SIZE, height: BALL_SIZE }}>
        <canvas
          ref={canvasRef}
          width={BALL_SIZE * DPR}
          height={BALL_SIZE * DPR}
          style={{ width: BALL_SIZE, height: BALL_SIZE, display: 'block' }}
        />
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          color: '#fff',
          fontWeight: 700,
          fontSize: 11,
          whiteSpace: 'nowrap',
          fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
          lineHeight: 1,
          pointerEvents: 'none',
          textShadow: '0 1px 3px rgba(0, 0, 0, 0.45)',
        }}>
          {mood}%
        </div>
      </div>
    </div>
  )
}
