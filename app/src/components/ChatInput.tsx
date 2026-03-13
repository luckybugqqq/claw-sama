import { useState, useRef, useCallback, useEffect } from 'react'
import { MessageCircle, Send, X, Loader, Mic, ChevronDown } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

const OPENCLAW_URL = 'http://127.0.0.1:18789/plugins/claw-sama/chat'

const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
const USE_NATIVE_STT = !SpeechRecognition

export function ChatInput({ visible = true, onActiveChange, uiAlign = 'right' }: { visible?: boolean; onActiveChange?: (hasText: boolean) => void; uiAlign?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [recording, setRecording] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<any>(null)
  const unlistenRef = useRef<UnlistenFn | null>(null)

  const send = useCallback(async (msg?: string) => {
    const finalMsg = (msg ?? text).trim()
    if (!finalMsg || sending) return
    setSending(true)
    try {
      await fetch(OPENCLAW_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: finalMsg }),
      })
      setText('')
      onActiveChange?.(false)
    } catch (err) {
      console.error('Failed to send message:', err)
    } finally {
      setSending(false)
    }
  }, [text, sending])

  const startRecording = useCallback(async () => {
    if (USE_NATIVE_STT) {
      // macOS: use Tauri native SFSpeechRecognizer
      try {
        const unlisten = await listen<{ text: string; isFinal: boolean }>('speech-result', (event) => {
          setText(event.payload.text)
          onActiveChange?.(event.payload.text.length > 0)
        })
        unlistenRef.current = unlisten
        await invoke('start_speech_recognition')
        setRecording(true)
        setOpen(true)
      } catch (err) {
        console.error('Native speech recognition error:', err)
        unlistenRef.current?.()
        unlistenRef.current = null
      }
      return
    }

    // Windows: use Web Speech API
    if (!SpeechRecognition) {
      console.error('SpeechRecognition not supported')
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'zh-CN'
    recognition.interimResults = true
    recognition.continuous = true

    recognition.onresult = (event: any) => {
      let transcript = ''
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript
      }
      setText(transcript)
      onActiveChange?.(transcript.length > 0)
    }

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error)
      setRecording(false)
    }

    recognition.onend = () => {
      setRecording(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }

    recognition.start()
    recognitionRef.current = recognition
    setRecording(true)
    setOpen(true)
  }, [])

  const stopRecording = useCallback(() => {
    if (USE_NATIVE_STT) {
      invoke('stop_speech_recognition').catch(console.error)
      unlistenRef.current?.()
      unlistenRef.current = null
      setRecording(false)
      return
    }

    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setRecording(false)
  }, [])

  // 鼠标移出按钮时也停止录音
  const handleMouseLeave = useCallback(() => {
    if (recording) stopRecording()
  }, [recording, stopRecording])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
    if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  // 全局快捷键
  useEffect(() => {
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (!visible) return
      const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement

      // Enter: 唤起输入框 / 聚焦输入框
      if (e.key === 'Enter' && !e.shiftKey && !inInput) {
        e.preventDefault()
        if (!open) {
          setOpen(true)
        }
        setTimeout(() => inputRef.current?.focus(), 50)
      }

      // Delete: 清空输入框
      if (e.key === 'Delete' && open) {
        e.preventDefault()
        setText('')
        onActiveChange?.(false)
        inputRef.current?.focus()
      }

      // F10: 按住说话
      if (e.key === 'F10' && !recording) {
        e.preventDefault()
        startRecording()
      }
    }
    const onGlobalKeyUp = (e: KeyboardEvent) => {
      if (recording && e.key === 'F10') {
        stopRecording()
      }
    }
    window.addEventListener('keydown', onGlobalKeyDown)
    window.addEventListener('keyup', onGlobalKeyUp)
    return () => {
      window.removeEventListener('keydown', onGlobalKeyDown)
      window.removeEventListener('keyup', onGlobalKeyUp)
    }
  }, [open, visible, recording, startRecording, stopRecording])

  if (!visible) return null

  if (!open) {
    return (
      <div style={{ position: 'absolute', bottom: 12, ...(uiAlign === 'left' ? { left: 12 } : { right: 12 }), display: 'flex', flexDirection: 'column', gap: 4, zIndex: 200, pointerEvents: 'auto' }}>
        <button
          onMouseDown={startRecording}
          onMouseUp={stopRecording}
          onMouseLeave={handleMouseLeave}
          style={{ ...fabStyle, background: recording ? 'rgba(255, 80, 80, 0.6)' : fabStyle.background }}
          title="按住说话 (F10)"
        >
          <Mic size={16} />
        </button>
        <button
          onClick={() => {
            setOpen(true)
            setTimeout(() => inputRef.current?.focus(), 50)
          }}
          style={fabStyle}
          title="发送消息 (Enter)"
        >
          <MessageCircle size={16} />
        </button>
      </div>
    )
  }

  return (
    <>
    <div style={{ position: 'absolute', bottom: 56, ...(uiAlign === 'left' ? { left: 12 } : { right: 12 }), zIndex: 200, pointerEvents: 'auto' }}>
      <button
        onMouseDown={startRecording}
        onMouseUp={stopRecording}
        onMouseLeave={handleMouseLeave}
        style={{ ...fabStyle, background: recording ? 'rgba(255, 80, 80, 0.6)' : fabStyle.background }}
        title="按住说话 (F10)"
      >
        <Mic size={16} />
      </button>
    </div>
    <div style={barStyle}>
      <div style={{ flex: 1, position: 'relative' }}>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            onActiveChange?.(e.target.value.length > 0)
          }}
          onKeyDown={handleKeyDown}
          placeholder=""
          disabled={sending}
          style={{ ...inputStyle, paddingRight: text.trim() ? 28 : 10 }}
          autoFocus
        />
        {text.trim() && (
          <button
            onClick={() => { setText(''); onActiveChange?.(false); inputRef.current?.focus() }}
            style={clearBtnStyle}
            title="清空 (Delete)"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <button onClick={() => send()} disabled={sending || !text.trim()} style={sendBtnStyle} title="发送 (Enter)">
        {sending ? <Loader size={16} /> : <Send size={14} />}
      </button>
      <button onClick={() => setOpen(false)} style={closeBtnStyle} title="收起">
        <ChevronDown size={16} />
      </button>
    </div>
    </>
  )
}

const fabStyle: React.CSSProperties = {
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
  zIndex: 200,
  pointerEvents: 'auto',
}

const barStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  left: 12,
  right: 12,
  display: 'flex',
  gap: 4,
  zIndex: 200,
  pointerEvents: 'auto',
}

const clearBtnStyle: React.CSSProperties = {
  position: 'absolute',
  right: 4,
  top: '50%',
  transform: 'translateY(-50%)',
  width: 20,
  height: 20,
  border: 'none',
  borderRadius: 4,
  background: 'rgba(255, 255, 255, 0.15)',
  color: 'rgba(255, 255, 255, 0.6)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 32,
  boxSizing: 'border-box' as const,
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 6,
  background: 'rgba(0, 0, 0, 0.4)',
  backdropFilter: 'blur(6px)',
  color: '#fff',
  fontSize: 14,
  padding: '0 10px',
  outline: 'none',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}

const sendBtnStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  border: 'none',
  borderRadius: 6,
  background: 'rgba(100, 160, 255, 0.5)',
  backdropFilter: 'blur(6px)',
  color: '#fff',
  fontSize: 16,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const closeBtnStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  border: 'none',
  borderRadius: 6,
  background: 'rgba(125, 125, 125, 0.28)',
  backdropFilter: 'blur(6px)',
  color: 'rgba(255, 255, 255, 0.8)',
  fontSize: 14,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}
