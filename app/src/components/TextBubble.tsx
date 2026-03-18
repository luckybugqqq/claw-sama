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
  imageUrl?: string
  sendFirstTts?: boolean
  appendText?: boolean
  replyDone?: boolean
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
  // Current full text (for appending subsequent sentences)
  const fullTextRef = useRef('')
  // Current char rate (for restarting typewriter on appendText)
  const charRateRef = useRef(100)
  // Current charCount as a ref (for restarting typewriter from correct position)
  const charCountRef = useRef(0)
  // Pending text to reveal when a given audio index starts playing
  const pendingTextForAudioRef = useRef<Map<number, string>>(new Map())

  // Audio queue for sequential playback — keyed by index for ordering
  const audioQueueRef = useRef<Map<number, string>>(new Map())
  const audioPlayingRef = useRef<boolean>(false)
  const audioNextIndexRef = useRef<number>(0)
  const audioReceivedRef = useRef<number>(0)

  // === sendFirstTts queue ===
  // When a new sendFirstTts arrives while a previous one is still playing,
  // queue it instead of interrupting. Processed when the current reply finishes.
  const pendingSendFirstTtsRef = useRef<VrmMessage[]>([])
  // appendText messages buffered while sendFirstTts is queued
  const pendingAppendRef = useRef<VrmMessage[]>([])
  // replyDone: all sentences dispatched for current reply — required before hide is scheduled
  // Default true so non-sendFirstTts messages (plain text, images) can still schedule hide.
  const replyDoneRef = useRef(true)
  // replyDone arrived while sendFirstTts was still queued — apply after draining queue
  const pendingReplyDoneRef = useRef(false)

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
    chars.current = []
    fullTextRef.current = ''
    charCountRef.current = 0
    pendingTextForAudioRef.current.clear()
    pendingAppendRef.current = []
    replyDoneRef.current = true
    pendingReplyDoneRef.current = false
    if (typewriterRef.current) { clearInterval(typewriterRef.current); typewriterRef.current = null }
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }, [])

  // Ref to handleMessage — used by tryScheduleHide to drain the pending queue
  const handleMessageRef = useRef<(msg: VrmMessage) => void>(() => {})

  // Central function: check if all conditions are met to schedule hide (or drain queue)
  const tryScheduleHide = useCallback(() => {
    // Don't schedule if already scheduled
    if (timerRef.current) return

    const typewriterDone = typewriterRef.current === null
    const audioDone = !audioPlayingRef.current && audioQueueRef.current.size === 0

    if (typewriterDone && audioDone) {
      // Check pending sendFirstTts queue before hiding
      if (pendingSendFirstTtsRef.current.length > 0) {
        const next = pendingSendFirstTtsRef.current.shift()!
        handleMessageRef.current(next)
        // Process any buffered appendText messages for this reply
        const appends = pendingAppendRef.current.splice(0)
        for (const a of appends) handleMessageRef.current(a)
        // Apply replyDone that arrived while this reply was queued
        if (pendingReplyDoneRef.current) {
          pendingReplyDoneRef.current = false
          replyDoneRef.current = true
        }
        return
      }
      if (!replyDoneRef.current) return
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
    audioReceivedRef.current = 0
    pendingTextForAudioRef.current.clear()
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

    // Reveal text for this sentence if it arrived via appendText
    const pendingText = pendingTextForAudioRef.current.get(nextIdx)
    if (pendingText !== undefined) {
      pendingTextForAudioRef.current.delete(nextIdx)
      const newGraphemes = [...segmenter.segment(pendingText)].map((s) => s.segment)
      chars.current = [...chars.current, ...newGraphemes]
      fullTextRef.current = fullTextRef.current + pendingText
      setText(fullTextRef.current)
      if (!typewriterRef.current) {
        // Restart typewriter from current position
        let idx = charCountRef.current
        typewriterRef.current = setInterval(() => {
          idx++
          if (idx >= chars.current.length) {
            setCharCount(chars.current.length)
            charCountRef.current = chars.current.length
            clearInterval(typewriterRef.current!); typewriterRef.current = null
            tryScheduleHide()
          } else {
            setCharCount(idx)
            charCountRef.current = idx
          }
        }, charRateRef.current)
      }
      // else: typewriter is running and will pick up new chars via chars.current.length
    }

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
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  // Watchdog: if bubble is stuck (no audio, no typewriter, no queued work), force-hide after 30s
  useEffect(() => {
    const id = setInterval(() => {
      if (!visibleRef.current) return
      if (audioPlayingRef.current) return
      if (typewriterRef.current !== null) return
      if (audioQueueRef.current.size > 0) return
      if (pendingSendFirstTtsRef.current.length > 0) return
      if (timerRef.current !== null) return  // hide already scheduled
      console.warn('[claw-sama] watchdog: bubble stuck, forcing hide')
      hideBubbleRef.current()
    }, 30_000)
    return () => clearInterval(id)
  }, [])

  // Stable handleMessage — never causes SSE reconnect
  const handleMessage = useCallback((msg: VrmMessage) => {
    // Audio-only message (legacy path, kept for compatibility)
    if (!msg.text && msg.audioUrl && !msg.appendText) {
      audioReceivedRef.current++
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      const idx = msg.audioIndex ?? audioReceivedRef.current - 1
      audioQueueRef.current.set(idx, msg.audioUrl)
      playNextAudioRef.current()
      return
    }

    // appendText: subsequent sentence with matching audio — queue both together
    if (msg.appendText && msg.text) {
      // If sendFirstTts is queued (previous reply still playing), buffer this too
      if (pendingSendFirstTtsRef.current.length > 0 || audioPlayingRef.current) {
        if (pendingSendFirstTtsRef.current.length > 0) {
          pendingAppendRef.current.push(msg)
          return
        }
      }
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      const idx = msg.audioIndex ?? 0
      // Store text to reveal when this audio index starts playing
      pendingTextForAudioRef.current.set(idx, msg.text)
      if (msg.audioUrl) {
        audioQueueRef.current.set(idx, msg.audioUrl)
        playNextAudioRef.current()
      }
      return
    }

    // Image-only message
    if (!msg.text && msg.imageUrl) {
      setText('')
      setCharCount(0)
      if (typewriterRef.current) { clearInterval(typewriterRef.current); typewriterRef.current = null }
      setImageUrl(msg.imageUrl)
      setVisible(true)
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

    // --- Text message ---

    // Cancel pending hide — new text arrived
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    if (typewriterRef.current) { clearInterval(typewriterRef.current); typewriterRef.current = null }

    // sendFirstTts: queue if something is currently playing, otherwise reset and play
    if (msg.sendFirstTts) {
      const busy = audioPlayingRef.current || typewriterRef.current !== null
      if (busy) {
        pendingSendFirstTtsRef.current.push(msg)
        return
      }
      replyDoneRef.current = false
      const lipSync = LipSync.getInstance()
      lipSync.stopAudio()
      // Preserve early-arriving audio and text for this new reply (index >= 1)
      const earlyAudio = new Map<number, string>()
      for (const [idx, url] of audioQueueRef.current) {
        if (idx >= 1) earlyAudio.set(idx, url)
      }
      const earlyText = new Map<number, string>()
      for (const [idx, t] of pendingTextForAudioRef.current) {
        if (idx >= 1) earlyText.set(idx, t)
      }
      audioQueueRef.current.clear()
      pendingTextForAudioRef.current.clear()
      if (msg.audioUrl) audioQueueRef.current.set(0, msg.audioUrl)
      for (const [idx, url] of earlyAudio) audioQueueRef.current.set(idx, url)
      for (const [idx, t] of earlyText) pendingTextForAudioRef.current.set(idx, t)
      audioPlayingRef.current = false
      audioNextIndexRef.current = 0
      audioReceivedRef.current = 0
    } else {
      audioReceivedRef.current = 0
      audioNextIndexRef.current = 0
    }

    const fullText = msg.text!
    const graphemes = [...segmenter.segment(fullText)].map((s) => s.segment)
    chars.current = graphemes
    fullTextRef.current = fullText
    charCountRef.current = 0

    setText(fullText)
    setThinking(false)
    setVisible(true)
    setCharCount(0)

    const baseRate = getCharRate(fullText, ttsEnabledRef.current)
    charRateRef.current = baseRate

    if (graphemes.length === 0) {
      tryScheduleHideRef.current()
    } else {
      const emotionDuration = graphemes.length * baseRate + 5000
      setTimeout(() => onMessageRef.current?.({ ...msg, emotionDuration }), 1000)

      let idx = 0
      typewriterRef.current = setInterval(() => {
        idx++
        if (idx >= chars.current.length) {
          setCharCount(chars.current.length)
          charCountRef.current = chars.current.length
          if (typewriterRef.current) { clearInterval(typewriterRef.current); typewriterRef.current = null }
          tryScheduleHideRef.current()
        } else {
          setCharCount(idx)
          charCountRef.current = idx
        }
      }, baseRate)
    }

    // All audio goes through the queue via playNextAudio.
    if (msg.sendFirstTts && ttsEnabledRef.current) {
      playNextAudioRef.current()
    }
  }, []) // stable — no deps, uses refs for everything

  // Keep handleMessageRef in sync so tryScheduleHide can drain the queue
  handleMessageRef.current = handleMessage

  useEffect(() => {
    const es = new EventSource('http://127.0.0.1:18789/plugins/claw-sama/events')
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.clearText) {
          if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
          if (typewriterRef.current) { clearInterval(typewriterRef.current); typewriterRef.current = null }
          setText('')
          setCharCount(0)
          setThinking(false)
          setVisible(false)
          setImageUrl(null)
          audioQueueRef.current.clear()
          audioPlayingRef.current = false
          audioNextIndexRef.current = 0
          audioReceivedRef.current = 0
          pendingTextForAudioRef.current.clear()
          pendingSendFirstTtsRef.current = []
          pendingAppendRef.current = []
          replyDoneRef.current = true
          pendingReplyDoneRef.current = false
          return
        }
        if (data.replyDone) {
          if (pendingSendFirstTtsRef.current.length > 0) {
            // sendFirstTts for this reply is still queued — buffer replyDone until queue drains
            pendingReplyDoneRef.current = true
          } else {
            replyDoneRef.current = true
            tryScheduleHideRef.current()
          }
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
