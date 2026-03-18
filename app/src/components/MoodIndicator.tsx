import { useState, useEffect, useRef, useCallback } from 'react'

interface MoodBubble {
  id: number
  delta: number
}

interface MoodIndicatorProps {
  uiAlign?: 'left' | 'right'
}

const OPENCLAW_URL = 'http://127.0.0.1:18789'

const BAR_WIDTH = 10
const BAR_HEIGHT = 120
const BORDER_GAP = 4      // gap between bar and border
const BORDER_WIDTH = 2    // border stroke thickness
const HEART_SIZE = 23
const DPR = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1

// Wave parameters (ported from Android HorizontalWaveProgressView)
const WAVE_LENGTH = 8
const WAVE_HEIGHT = 2.5

// 5 tiers: 90+ pink, 70+ orange, 50+ green, 30+ blue, 0+ grey
function moodRGB(percent: number): [number, number, number] {
  if (percent >= 90) return [255, 107, 157]
  if (percent >= 70) return [255, 165, 70]
  if (percent >= 50) return [72, 199, 142]
  if (percent >= 30) return [78, 168, 222]
  return [160, 168, 180]
}

/** Rounded-rect path helper */
function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0)
  ctx.lineTo(x + w, y + h - r)
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2)
  ctx.lineTo(x + r, y + h)
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI)
  ctx.lineTo(x, y + r)
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5)
  ctx.closePath()
}

/** Heart path centered at (cx, cy) with given size — classic round heart */
function heartPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  const r = size * 0.45
  const topY = cy - r * 0.4
  ctx.beginPath()
  // Bottom tip (rounded)
  ctx.moveTo(cx, cy + r * 0.85)
  // Left curve
  ctx.bezierCurveTo(cx - r * 0.5, cy + r * 0.6, cx - r * 1.1, cy + r * 0.1, cx - r, topY)
  // Left bump (arc)
  ctx.arc(cx - r * 0.5, topY, r * 0.5, Math.PI, 0, false)
  // Right bump (arc)
  ctx.arc(cx + r * 0.5, topY, r * 0.5, Math.PI, 0, false)
  // Right curve
  ctx.bezierCurveTo(cx + r * 1.1, cy + r * 0.1, cx + r * 0.5, cy + r * 0.6, cx, cy + r * 0.85)
  ctx.closePath()
}

/**
 * Common wave drawing logic used by both the bar and the heart.
 * Draws dual bezier waves inside the current clip region.
 */
function drawWaves(
  ctx: CanvasRenderingContext2D,
  regionWidth: number,
  regionHeight: number,
  waterY: number,
  moveDistance: number,
  cr: number, cg: number, cb: number,
) {
  const fullCycle = WAVE_LENGTH * 2
  const waveNumber = Math.ceil(regionWidth / fullCycle) + 2

  const drawWave = (scrollDir: number, alpha: number) => {
    ctx.beginPath()
    const offset = (moveDistance * scrollDir) % fullCycle
    let x = -fullCycle + offset
    ctx.moveTo(x, waterY)

    for (let i = 0; i < waveNumber * 2; i++) {
      ctx.quadraticCurveTo(x + WAVE_LENGTH / 2, waterY - WAVE_HEIGHT, x + WAVE_LENGTH, waterY)
      x += WAVE_LENGTH
      ctx.quadraticCurveTo(x + WAVE_LENGTH / 2, waterY + WAVE_HEIGHT, x + WAVE_LENGTH, waterY)
      x += WAVE_LENGTH
    }

    ctx.lineTo(x, regionHeight)
    ctx.lineTo(-fullCycle, regionHeight)
    ctx.closePath()
    ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha})`
    ctx.fill()
  }

  drawWave(-1, 0.55)
  drawWave(1, 1.0)
}

/**
 * Draw the vertical liquid-filled bar with border that has a gap.
 */
function drawLiquidBar(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  percent: number,
  moveDistance: number,
) {
  const radius = w / 2
  const totalW = w + (BORDER_GAP + BORDER_WIDTH) * 2
  const totalH = h + (BORDER_GAP + BORDER_WIDTH) * 2
  const offsetX = BORDER_GAP + BORDER_WIDTH
  const offsetY = BORDER_GAP + BORDER_WIDTH

  ctx.clearRect(0, 0, totalW, totalH)

  const waterY = h * (1 - percent / 100)
  const [cr, cg, cb] = moodRGB(percent)

  // ── Bar fill ──
  ctx.save()
  roundedRectPath(ctx, offsetX, offsetY, w, h, radius)
  ctx.clip()

  ctx.clearRect(offsetX, offsetY, w, h)

  ctx.save()
  ctx.translate(offsetX, offsetY)
  drawWaves(ctx, w, h, waterY, moveDistance, cr, cg, cb)
  ctx.restore()

  ctx.restore()

  // ── Border with gap ──
  const bx = offsetX - BORDER_GAP - BORDER_WIDTH / 2
  const by = offsetY - BORDER_GAP - BORDER_WIDTH / 2
  const bw = w + (BORDER_GAP + BORDER_WIDTH / 2) * 2
  const bh = h + (BORDER_GAP + BORDER_WIDTH / 2) * 2
  const br = radius + BORDER_GAP + BORDER_WIDTH / 2
  roundedRectPath(ctx, bx, by, bw, bh, br)
  ctx.strokeStyle = 'rgba(80, 80, 85, 0.75)'
  ctx.lineWidth = BORDER_WIDTH
  ctx.stroke()
}

/**
 * Draw liquid-filled heart icon with border and gap (matching bar style).
 */
function drawLiquidHeart(
  ctx: CanvasRenderingContext2D,
  size: number,
  percent: number,
  moveDistance: number,
) {
  ctx.clearRect(0, 0, size, size)

  const cx = size / 2
  const cy = size / 2
  const waterY = size * (1 - percent / 100)
  const [cr, cg, cb] = moodRGB(percent)

  // ── Heart fill ──
  ctx.save()
  heartPath(ctx, cx, cy, size)
  ctx.clip()

  ctx.fillStyle = 'rgba(60, 60, 65, 0.9)'
  ctx.fillRect(0, 0, size, size)

  drawWaves(ctx, size, size, waterY, moveDistance, cr, cg, cb)

  ctx.restore()
}

let bubbleIdCounter = 0

// Canvas total dimensions (bar + border gap)
const BAR_CANVAS_W = BAR_WIDTH + (BORDER_GAP + BORDER_WIDTH) * 2
const BAR_CANVAS_H = BAR_HEIGHT + (BORDER_GAP + BORDER_WIDTH) * 2

export function MoodIndicator({ uiAlign = 'right' }: MoodIndicatorProps) {
  const [mood, setMood] = useState(60)
  const [bubbles, setBubbles] = useState<MoodBubble[]>([])
  const [visible, setVisible] = useState(false)
  const [dragging, setDragging] = useState(false)
  const defaultX = (align: string) => align === 'left' ? window.innerWidth - 20 - BAR_CANVAS_W : 20
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: defaultX(uiAlign), y: 20 })
  const [userDragged, setUserDragged] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const barCanvasRef = useRef<HTMLCanvasElement>(null)
  const heartCanvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const displayPercentRef = useRef(60)
  const moveDistRef = useRef(0)

  useEffect(() => {
    if (!userDragged) setPos(p => ({ ...p, x: defaultX(uiAlign) }))
  }, [uiAlign, userDragged])

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

  // Canvas animation loop — draws both heart and bar
  useEffect(() => {
    const barCanvas = barCanvasRef.current
    const heartCanvas = heartCanvasRef.current
    if (!barCanvas || !heartCanvas) return
    const barCtx = barCanvas.getContext('2d')
    const heartCtx = heartCanvas.getContext('2d')
    if (!barCtx || !heartCtx) return

    barCanvas.width = BAR_CANVAS_W * DPR
    barCanvas.height = BAR_CANVAS_H * DPR
    barCtx.scale(DPR, DPR)

    heartCanvas.width = HEART_SIZE * DPR
    heartCanvas.height = HEART_SIZE * DPR
    heartCtx.scale(DPR, DPR)

    let running = true
    const animate = () => {
      if (!running) return
      const target = Math.max(2, mood)
      displayPercentRef.current += (target - displayPercentRef.current) * 0.08
      moveDistRef.current += 0.12

      drawLiquidBar(barCtx, BAR_WIDTH, BAR_HEIGHT, displayPercentRef.current, moveDistRef.current)
      drawLiquidHeart(heartCtx, HEART_SIZE, displayPercentRef.current, moveDistRef.current)
      animRef.current = requestAnimationFrame(animate)
    }
    animate()
    return () => { running = false; cancelAnimationFrame(animRef.current) }
  }, [mood])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(true)
    setUserDragged(true)
    setVisible(true)
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }

    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const offsetX = e.clientX - rect.left
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
      {/* Liquid-filled heart */}
      <canvas
        ref={heartCanvasRef}
        width={HEART_SIZE * DPR}
        height={HEART_SIZE * DPR}
        style={{ width: HEART_SIZE, height: HEART_SIZE, display: 'block', marginBottom: 4 }}
      />

      {/* Vertical liquid bar with border */}
      <div style={{ position: 'relative', width: BAR_CANVAS_W, height: BAR_CANVAS_H }}>
        <canvas
          ref={barCanvasRef}
          width={BAR_CANVAS_W * DPR}
          height={BAR_CANVAS_H * DPR}
          style={{ width: BAR_CANVAS_W, height: BAR_CANVAS_H, display: 'block' }}
        />
        {/* Floating bubbles */}
        {bubbles.map((b) => (
          <span
            key={b.id}
            style={{
              position: 'absolute',
              left: '50%',
              top: -20,
              transform: 'translateX(-50%)',
              fontSize: 14,
              fontWeight: 800,
              color: b.delta > 0 ? '#FF6B9D' : '#7EB0D5',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              animation: 'mood-bubble-float 2.5s ease-out forwards',
              fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
              textShadow: b.delta > 0
                ? '0 0 6px rgba(255,107,157,0.6), 0 1px 3px rgba(0,0,0,0.4)'
                : '0 0 6px rgba(126,176,213,0.6), 0 1px 3px rgba(0,0,0,0.4)',
            }}
          >
            {b.delta > 0 ? `❤️+${b.delta}` : `🩶${b.delta}`}
          </span>
        ))}
      </div>
    </div>
  )
}
