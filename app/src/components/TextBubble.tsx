import { useEffect, useState, useRef, useCallback } from 'react'
import { LipSync } from '../lip-sync'

interface VrmMessage {
  text?: string
  emotion?: string
  emotionDuration?: number
  emotionIntensity?: number
  duration?: number
  audioUrl?: string
}

export type OnVrmMessage = (msg: VrmMessage) => void

const CHAR_RATE_MS = 60
const AUDIO_BUFFER_MS = 2000
const POP_DURATION_MS = 300

// Inject pop animation keyframes once
const STYLE_ID = 'claw-pop-keyframes'
if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    @keyframes claw-pop-in {
      0% { opacity: 0; transform: scale(0) translateY(0.5em); }
      60% { opacity: 1; transform: scale(1.15) translateY(-0.05em); }
      100% { opacity: 1; transform: scale(1) translateY(0); }
    }
  `
  document.head.appendChild(style)
}

export function TextBubble({ onMessage, enabled = true, chatHasText = false, ttsEnabled = true }: { onMessage?: OnVrmMessage; enabled?: boolean; chatHasText?: boolean; ttsEnabled?: boolean }) {
  const [text, setText] = useState('')
  const [visible, setVisible] = useState(false)
  const [charCount, setCharCount] = useState(0) // how many chars are "revealed"
  const [thinking, setThinking] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typewriterRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Split text into grapheme clusters
  const chars = useRef<string[]>([])

  // Auto-scroll to bottom on char reveal
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [charCount])

  const handleMessage = useCallback((msg: VrmMessage) => {
    // Emotion-only message
    if (!msg.text) {
      if (msg.emotion) {
        onMessage?.({ ...msg, emotionDuration: msg.emotionDuration ?? 10000 })
        if (msg.emotion === 'think') {
          if (timerRef.current) clearTimeout(timerRef.current)
          if (typewriterRef.current) clearInterval(typewriterRef.current)
          const dots = '思考中...'
          setText(dots)
          chars.current = [...dots]
          setCharCount(0)
          setThinking(true)
          setVisible(true)
          let idx = 0
          typewriterRef.current = setInterval(() => {
            idx++
            if (idx >= dots.length) {
              setCharCount(dots.length)
              if (typewriterRef.current) clearInterval(typewriterRef.current)
            } else {
              setCharCount(idx)
            }
          }, CHAR_RATE_MS)
          timerRef.current = setTimeout(() => {
            setThinking(false)
            setVisible(false)
          }, 60000)
        } else if (thinking) {
          setThinking(false)
          setVisible(false)
          setText('')
        }
      }
      return
    }

    if (timerRef.current) clearTimeout(timerRef.current)
    if (typewriterRef.current) clearInterval(typewriterRef.current)

    const fullText = msg.text
    // Use Intl.Segmenter for proper grapheme splitting (handles emoji, CJK)
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const graphemes = [...segmenter.segment(fullText)].map((s) => s.segment)
    chars.current = graphemes

    setText(fullText)
    setCharCount(0)
    setThinking(false)
    setVisible(true)

    const fallbackDuration = msg.duration || (graphemes.length * CHAR_RATE_MS + 5000)

    const startTypewriter = (duration: number, audioDurationMs?: number) => {
      setTimeout(() => onMessage?.({ ...msg, emotionDuration: duration }), 1000)
      const charInterval = audioDurationMs
        ? Math.max(20, (audioDurationMs * 0.8) / graphemes.length)
        : CHAR_RATE_MS
      let idx = 0
      typewriterRef.current = setInterval(() => {
        idx++
        if (idx >= graphemes.length) {
          setCharCount(graphemes.length)
          if (typewriterRef.current) clearInterval(typewriterRef.current)
        } else {
          setCharCount(idx)
        }
      }, charInterval)
      timerRef.current = setTimeout(() => setVisible(false), duration)
    }

    if (ttsEnabled && msg.audioUrl) {
      const lipSync = LipSync.getInstance()
      lipSync.playAudio(msg.audioUrl).then((audioDurationMs) => {
        const duration = Math.max(audioDurationMs + AUDIO_BUFFER_MS, fallbackDuration)
        startTypewriter(duration, audioDurationMs)
      }).catch((err) => {
        console.error('Audio play failed:', err)
        startTypewriter(fallbackDuration)
      })
      setTimeout(() => {
        if (!typewriterRef.current) startTypewriter(fallbackDuration)
      }, 3000)
    } else {
      startTypewriter(fallbackDuration)
    }
  }, [onMessage, ttsEnabled])

  useEffect(() => {
    const es = new EventSource('http://127.0.0.1:18789/plugins/claw-sama/events')
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.clearText) {
          if (timerRef.current) clearTimeout(timerRef.current)
          if (typewriterRef.current) clearInterval(typewriterRef.current)
          setText('')
          setCharCount(0)
          setThinking(false)
          setVisible(false)
          return
        }
        const msg: VrmMessage = data
        handleMessage(msg)
      } catch { /* ignore malformed */ }
    }
    return () => {
      es.close()
      if (timerRef.current) clearTimeout(timerRef.current)
      if (typewriterRef.current) clearInterval(typewriterRef.current)
    }
  }, [handleMessage])

  if (!enabled || !visible || !text) return null

  if (thinking) {
    if (chatHasText) return null
    return (
      <div style={thinkingContainerStyle}>
        <div style={thinkingTextStyle}>
          {chars.current.slice(0, charCount).map((ch, i) => (
            <span key={i} style={popCharStyle(i)}>{ch}</span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      <div ref={scrollRef} style={boxStyle}>
        <div style={textStyle}>
          {chars.current.map((ch, i) => (
            i < charCount ? (
              <span key={i} style={popCharStyle(i)}>{ch === '\n' ? <br /> : ch}</span>
            ) : null
          ))}
        </div>
      </div>
    </div>
  )
}

function popCharStyle(index: number): React.CSSProperties {
  return {
    display: 'inline-block',
    animation: `claw-pop-in ${POP_DURATION_MS}ms ease-out both`,
    whiteSpace: 'pre',
  }
}

const thinkingContainerStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 13,
  left: 25,
  height: 32,
  display: 'flex',
  alignItems: 'center',
  zIndex: 250,
  pointerEvents: 'none',
}

const thinkingTextStyle: React.CSSProperties = {
  color: 'rgba(255, 255, 255, 0.6)',
  fontSize: 14,
  fontFamily: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  textShadow: '0 0 4px rgba(255,255,255,0.3)',
}

const containerStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 56,
  left: 0,
  width: '100%',
  zIndex: 100,
  pointerEvents: 'none',
  padding: 8,
  boxSizing: 'border-box',
}

const boxStyle: React.CSSProperties = {
  background: 'rgba(0, 0, 0, 0.35)',
  backdropFilter: 'blur(6px)',
  borderRadius: 12,
  border: '1px solid rgba(255, 255, 255, 0.15)',
  boxShadow: '0 0 12px rgba(100, 160, 255, 0.25), 0 0 24px rgba(100, 160, 255, 0.1)',
  padding: '8px 12px',
  height: 140,
  overflowY: 'auto' as const,
}

const textStyle: React.CSSProperties = {
  color: '#fff',
  fontSize: 18,
  lineHeight: 1.6,
  wordBreak: 'break-word',
  fontFamily: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  textShadow: '0 0 6px rgba(255,255,255,0.5)',
}
