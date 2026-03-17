import { useEffect, useState, useRef, useCallback } from 'react'
import { LipSync } from '../lip-sync'

interface VrmMessage {
  text?: string
  emotion?: string
  emotionDuration?: number
  emotionIntensity?: number
  duration?: number
  audioUrl?: string
  audioIndex?: number
  audioTotal?: number
  streaming?: boolean
  imageUrl?: string
}

export type OnVrmMessage = (msg: VrmMessage) => void

// CJK detection: check proportion of CJK characters in text
function cjkRatio(text: string): number {
  const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff]/g
  const matches = text.match(CJK_RE)
  return matches ? matches.length / text.length : 0
}

// Dynamic rate based on CJK proportion
function getCharRate(text: string, ttsEnabled: boolean): number {
  const ratio = cjkRatio(text)
  if (ttsEnabled) {
    // CJK: 200ms/char, English: 60ms/char, interpolate
    return Math.round(200 * ratio + 60 * (1 - ratio))
  }
  // CJK: 80ms/char, English: 30ms/char, interpolate
  return Math.round(80 * ratio + 30 * (1 - ratio))
}
const HIDE_DELAY_MS = 2000     // delay after everything is done before hiding
const POP_DURATION_MS = 300

// Grapheme segmenter singleton
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// Keyframes (claw-pop-in) are in index.html <style>

export function TextBubble({ onMessage, enabled = true, ttsEnabled = true }: { onMessage?: OnVrmMessage; enabled?: boolean; ttsEnabled?: boolean }) {
  const [text, setText] = useState('')
  const [visible, setVisible] = useState(false)
  const [charCount, setCharCount] = useState(0)
  const [thinking, setThinking] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [zoomedSrc, setZoomedSrc] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typewriterRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Split text into grapheme clusters
  const chars = useRef<string[]>([])

  // Track previously revealed count for incremental streaming
  const prevRevealedRef = useRef<number>(0)

  // Audio queue for sequential playback — keyed by index for ordering
  const audioQueueRef = useRef<Map<number, string>>(new Map())
  const audioPlayingRef = useRef<boolean>(false)
  const audioNextIndexRef = useRef<number>(0)
  const audioTotalRef = useRef<number>(0)
  const audioReceivedRef = useRef<number>(0)

  // === Hide lifecycle tracking ===
  // The bubble hides only when ALL three conditions are met:
  //   1. streamingDone: received a non-streaming (final) text message
  //   2. typewriter finished: typewriterRef.current === null
  //   3. audio finished: no audio playing and queue empty
  const streamingDoneRef = useRef(false)

  // Auto-scroll to bottom on char reveal
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [charCount])

  const hideBubble = useCallback(() => {
    setVisible(false)
    setText('')
    setCharCount(0)
    setImageUrl(null)
    setThinking(false)
    prevRevealedRef.current = 0
    if (typewriterRef.current) { clearInterval(typewriterRef.current); typewriterRef.current = null }
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }, [])

  // Central function: check if all conditions are met to schedule hide
  const tryScheduleHide = useCallback(() => {
    // Don't schedule if already scheduled
    if (timerRef.current) return

    const typewriterDone = typewriterRef.current === null
    const audioDone = !audioPlayingRef.current && audioQueueRef.current.size === 0
    const streamingDone = streamingDoneRef.current

    if (streamingDone && typewriterDone && audioDone) {
      timerRef.current = setTimeout(hideBubble, HIDE_DELAY_MS)
    }
  }, [hideBubble])

  // Interrupt: stop all audio playback and clear queue
  const interruptAudio = useCallback(() => {
    const lipSync = LipSync.getInstance()
    lipSync.stopAudio()
    audioQueueRef.current.clear()
    audioPlayingRef.current = false
    audioNextIndexRef.current = 0
    audioTotalRef.current = 0
    audioReceivedRef.current = 0
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }, [])

  // Expose interrupt globally for voice call to use
  useEffect(() => {
    (window as any).__clawInterruptAudio = interruptAudio
    return () => { delete (window as any).__clawInterruptAudio }
  }, [interruptAudio])

  const playNextAudio = useCallback(() => {
    if (audioPlayingRef.current) return
    const nextIdx = audioNextIndexRef.current
    const url = audioQueueRef.current.get(nextIdx)
    if (!url) {
      // Queue empty — check if we can hide
      tryScheduleHide()
      return
    }
    audioQueueRef.current.delete(nextIdx)
    audioNextIndexRef.current = nextIdx + 1
    audioPlayingRef.current = true
    const lipSync = LipSync.getInstance()
    const onDone = () => {
      audioPlayingRef.current = false
      if (audioQueueRef.current.has(audioNextIndexRef.current)) {
        playNextAudio()
      } else {
        // No more queued audio — try to hide (will only succeed if streaming & typewriter also done)
        tryScheduleHide()
      }
    }
    lipSync.playAudio(url).then((durationMs) => {
      setTimeout(onDone, durationMs)
    }).catch(onDone)
  }, [tryScheduleHide])

  // Use refs for callback dependencies to keep handleMessage stable
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage
  const ttsEnabledRef = useRef(ttsEnabled)
  ttsEnabledRef.current = ttsEnabled
  const playNextAudioRef = useRef(playNextAudio)
  playNextAudioRef.current = playNextAudio
  const tryScheduleHideRef = useRef(tryScheduleHide)
  tryScheduleHideRef.current = tryScheduleHide
  const hideBubbleRef = useRef(hideBubble)
  hideBubbleRef.current = hideBubble
  const thinkingRef = useRef(thinking)
  thinkingRef.current = thinking

  // Stable handleMessage — never causes SSE reconnect
  const handleMessage = useCallback((msg: VrmMessage) => {
    // Audio-only message (from TTS queue broadcast)
    if (!msg.text && msg.audioUrl) {
      if (msg.audioTotal) audioTotalRef.current = msg.audioTotal
      audioReceivedRef.current++
      // Cancel any pending hide — more content arrived
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      const idx = msg.audioIndex ?? audioReceivedRef.current - 1
      audioQueueRef.current.set(idx, msg.audioUrl)
      playNextAudioRef.current()
      return
    }

    // Image-only message
    if (!msg.text && msg.imageUrl) {
      setText('')
      setCharCount(0)
      if (typewriterRef.current) { clearInterval(typewriterRef.current); typewriterRef.current = null }
      prevRevealedRef.current = 0
      setImageUrl(msg.imageUrl)
      setVisible(true)
      streamingDoneRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => hideBubbleRef.current(), 15_000)
      return
    }

    // Emotion-only message
    if (!msg.text) {
      if (msg.emotion) {
        onMessageRef.current?.({ ...msg, emotionDuration: msg.emotionDuration ?? 10000 })
        if (thinkingRef.current) {
          setThinking(false)
          hideBubbleRef.current()
        }
      }
      return
    }

    // --- Text message (streaming or final) ---

    // Cancel pending hide — new text arrived
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    if (typewriterRef.current) { clearInterval(typewriterRef.current); typewriterRef.current = null }

    const isStreaming = msg.streaming === true

    // On first text message of a new reply, reset audio tracking
    if (!isStreaming || prevRevealedRef.current === 0) {
      audioTotalRef.current = 0
      audioReceivedRef.current = 0
      audioNextIndexRef.current = 0
    }

    // Track streaming state
    streamingDoneRef.current = !isStreaming

    const fullText = msg.text
    const graphemes = [...segmenter.segment(fullText)].map((s) => s.segment)
    chars.current = graphemes

    setText(fullText)
    setThinking(false)
    setVisible(true)

    // Incremental streaming: keep previously revealed chars visible
    const previouslyRevealed = prevRevealedRef.current
    const startFrom = isStreaming && previouslyRevealed <= graphemes.length
      ? Math.min(previouslyRevealed, graphemes.length)
      : 0
    setCharCount(startFrom)

    const baseRate = getCharRate(fullText, ttsEnabledRef.current)

    const startTypewriter = (audioDurationMs?: number) => {
      const remainingChars = graphemes.length - startFrom
      if (remainingChars <= 0) {
        prevRevealedRef.current = graphemes.length
        setCharCount(graphemes.length)
        // typewriterRef stays null — typewriter is "done"
        tryScheduleHideRef.current()
        return
      }

      const charInterval = audioDurationMs
        ? Math.max(20, (audioDurationMs * 0.8) / remainingChars)
        : baseRate

      const emotionDuration = audioDurationMs
        ? Math.max(audioDurationMs + HIDE_DELAY_MS, remainingChars * charInterval + 5000)
        : remainingChars * charInterval + 5000
      setTimeout(() => onMessageRef.current?.({ ...msg, emotionDuration }), 1000)

      let idx = startFrom
      typewriterRef.current = setInterval(() => {
        idx++
        if (idx >= graphemes.length) {
          setCharCount(graphemes.length)
          prevRevealedRef.current = graphemes.length
          if (typewriterRef.current) { clearInterval(typewriterRef.current); typewriterRef.current = null }
          // Typewriter done — check if we can hide
          tryScheduleHideRef.current()
        } else {
          setCharCount(idx)
          prevRevealedRef.current = idx
        }
      }, charInterval)
    }

    if (ttsEnabledRef.current && msg.audioUrl) {
      // First text+audio message: play directly and start typewriter synced to audio
      audioQueueRef.current.clear()
      audioPlayingRef.current = false
      const lipSync = LipSync.getInstance()
      lipSync.playAudio(msg.audioUrl).then((audioDurationMs) => {
        startTypewriter(audioDurationMs)
      }).catch((err) => {
        console.error('Audio play failed:', err)
        startTypewriter()
      })
      // Fallback: if audio takes too long to load, start typewriter anyway
      setTimeout(() => {
        if (!typewriterRef.current && prevRevealedRef.current < graphemes.length) {
          startTypewriter()
        }
      }, 3000)
    } else {
      startTypewriter()
    }
  }, []) // stable — no deps, uses refs for everything

  useEffect(() => {
    const es = new EventSource('http://127.0.0.1:18789/plugins/claw-sama/events')
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        console.log('[claw-sama] SSE message:', data.imageUrl ? `imageUrl=${data.imageUrl}` : '', data.text ? `text=${data.text.slice(0, 50)}...` : '', data.clearText ? 'clearText' : '')
        if (data.clearText) {
          if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
          if (typewriterRef.current) { clearInterval(typewriterRef.current); typewriterRef.current = null }
          setText('')
          setCharCount(0)
          setThinking(false)
          setVisible(false)
          setImageUrl(null)
          prevRevealedRef.current = 0
          streamingDoneRef.current = false
          audioQueueRef.current.clear()
          audioPlayingRef.current = false
          audioNextIndexRef.current = 0
          audioTotalRef.current = 0
          audioReceivedRef.current = 0
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

  const showBubble = enabled && visible && (!!text || !!imageUrl)

  return (
    <>
      {showBubble && (
        <div style={containerStyle}>
          <div ref={scrollRef} style={boxStyle} data-no-passthrough>
            {imageUrl && (
              <img
                src={imageUrl}
                alt=""
                style={imageThumbStyle}
                onClick={() => setZoomedSrc(imageUrl)}
                onError={() => setImageUrl(null)}
              />
            )}
            {text && (
              <div style={textStyle}>
                {chars.current.map((ch, i) => (
                  i < charCount ? (
                    <span key={i} style={popCharStyle}>{ch === '\n' ? <br /> : ch}</span>
                  ) : null
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {zoomedSrc && (
        <div style={overlayStyle} data-no-passthrough>
          <div style={{ position: 'relative', display: 'inline-block', maxWidth: '90%', maxHeight: '90%' }}>
            <img
              src={zoomedSrc}
              alt=""
              style={zoomedImageStyle}
              onError={() => setZoomedSrc(null)}
            />
            <button
              style={closeButtonStyle}
              onClick={() => setZoomedSrc(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </>
  )
}

const imageThumbStyle: React.CSSProperties = {
  maxWidth: '80%',
  maxHeight: 120,
  borderRadius: 6,
  border: '1px solid rgba(255, 255, 255, 0.3)',
  objectFit: 'contain' as const,
  marginBottom: 4,
  display: 'block',
  cursor: 'pointer',
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: 'rgba(0, 0, 0, 0.7)',
  backdropFilter: 'blur(8px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 10000,
  pointerEvents: 'auto',
}

const closeButtonStyle: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  width: 32,
  height: 32,
  border: 'none',
  borderRadius: 6,
  background: 'rgba(125, 125, 125, 0.28)',
  backdropFilter: 'blur(6px)',
  color: 'rgba(255, 255, 255, 0.8)',
  fontSize: 16,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 10001,
}

const zoomedImageStyle: React.CSSProperties = {
  maxWidth: '100%',
  maxHeight: '100%',
  borderRadius: 8,
  border: '1px solid rgba(255, 255, 255, 0.3)',
  boxShadow: '0 0 24px rgba(100, 160, 255, 0.4)',
  objectFit: 'contain' as const,
  display: 'block',
}

const popCharStyle: React.CSSProperties = {
  display: 'inline-block',
  animation: `claw-pop-in ${POP_DURATION_MS}ms ease-out both`,
  whiteSpace: 'pre',
}

const containerStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 80,
  left: 0,
  width: '100%',
  zIndex: 200,
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
  pointerEvents: 'auto',
  userSelect: 'text',
  cursor: 'text',
}

const textStyle: React.CSSProperties = {
  color: '#fff',
  fontSize: 22,
  lineHeight: 1.6,
  wordBreak: 'break-word',
  fontFamily: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  textShadow: '0 0 6px rgba(255,255,255,0.5)',
}
