import { useEffect, useRef, useState, useCallback } from 'react'
import { VRMScene } from './components/VRMScene'
import type { VRMSceneHandle, TouchRegion } from './components/VRMScene'
import { TextBubble } from './components/TextBubble'
import type { OnVrmMessage } from './components/TextBubble'
import { ChatInput } from './components/ChatInput'
import { ResizeHandles } from './components/ResizeHandles'
import { SettingsPanel } from './components/SettingsPanel'
import { usePassThrough } from './hooks/usePassThrough'
import { dancePresets } from './motion-controller'
import { LipSync } from './lip-sync'
import { bindScene } from './api'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { HistoryPanel } from './components/HistoryPanel'
import { MoodIndicator } from './components/MoodIndicator'
import { Menu, Pin, Move, RotateCcw, Rotate3D, EyeOff, Settings, Music } from 'lucide-react'

const DEFAULT_MODEL = '/model1.vrm'
const OPENCLAW_URL = 'http://127.0.0.1:18789'

// Module-level to survive any component remount
let lastTouchMemoTime = 0
const TOUCH_MEMO_COOLDOWN = 3_000
let lastTouchChatTime = 0
const TOUCH_CHAT_COOLDOWN = 60_000

// 情绪 → 动作映射 (action names from motion-controller presets)
const emotionActionMap: Record<string, string> = {
  think: 'scratchHead',
  question: 'point',
  curious: 'scratchHead',
  happy: 'happy',
  surprised: 'excited',
  angry: 'angry',
  awkward: 'playFingers',
  sad: 'shy',
  love: 'shy',
  flirty: 'shy',
  greeting: 'greeting',
  relaxed: 'salute',
  neutral: 'salute',
}


const btnStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  border: 'none',
  borderRadius: 6,
  background: 'rgba(125, 125, 125, 0.28)',
  backdropFilter: 'blur(6px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'rgba(255, 255, 255, 0.8)',
  fontSize: 16,
  cursor: 'pointer',
}

export default function App() {
  const sceneRef = useRef<VRMSceneHandle>(null)
  const [pinned, setPinned] = useState(true)
  const [tracking, setTracking] = useState<'mouse' | 'camera'>('mouse')
  const [showText, setShowText] = useState(true)
  const [collapsed, setCollapsed] = useState(false)

  const [ttsEnabled, setTtsEnabled] = useState(true)
  const [modelPath, setModelPath] = useState(DEFAULT_MODEL)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [hideUI, setHideUI] = useState(false)
  const [volume, setVolume] = useState(0.5)
  const [uiAlign, setUiAlign] = useState<'left' | 'right'>('right')
  const [dancing, setDancing] = useState(false)
  const [currentDance, setCurrentDance] = useState('jile')
  const [customDancePreset, setCustomDancePreset] = useState<import('./motion-controller').DancePreset | undefined>(undefined)
  const [hideMood, setHideMood] = useState(false)
  const [screenObserve, setScreenObserve] = useState(false)
  const [screenObserveInterval, setScreenObserveInterval] = useState(60)
  const [language, setLanguage] = useState<'zh' | 'en'>(() => navigator.language.startsWith('zh') ? 'zh' : 'en')
  const t = (zh: string, en: string) => language === 'en' ? en : zh
  usePassThrough(!settingsOpen && !historyOpen)

  // Load persisted settings on mount
  useEffect(() => {
    fetch(`${OPENCLAW_URL}/plugins/claw-sama/settings`)
      .then((r) => r.json())
      .then((s) => {
        if (s.modelPath) setModelPath(s.modelPath)
        if (s.ttsEnabled !== undefined) setTtsEnabled(s.ttsEnabled)
        if (s.showText !== undefined) setShowText(s.showText)
        if (s.hideUI !== undefined) setHideUI(s.hideUI)
        if (s.tracking) { setTracking(s.tracking); sceneRef.current?.setTrackingMode(s.tracking) }
        if (s.volume !== undefined) { setVolume(s.volume); LipSync.getInstance().setVolume(s.volume); sceneRef.current?.setBgmVolume(s.volume) }
        if (s.uiAlign) setUiAlign(s.uiAlign)
        if (s.hideMood !== undefined) setHideMood(s.hideMood)
        if (s.screenObserve !== undefined) setScreenObserve(s.screenObserve)
        if (s.screenObserveInterval !== undefined) setScreenObserveInterval(s.screenObserveInterval)
        if (s.currentDance) setCurrentDance(s.currentDance)
        if (s.customDancePreset) setCustomDancePreset(s.customDancePreset)
        if (s.language) {
          setLanguage(s.language)
        } else {
          // No saved language — persist the detected system language to backend
          const detected = navigator.language.startsWith('zh') ? 'zh' : 'en'
          fetch(`${OPENCLAW_URL}/plugins/claw-sama/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ language: detected }),
          }).catch(() => {})
        }
      })
      .catch(() => {})
  }, [])

  const saveSettings = (patch: Record<string, unknown>) => {
    fetch(`${OPENCLAW_URL}/plugins/claw-sama/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {})
  }

  useEffect(() => {
    const unlisten = listen('open-settings', () => setSettingsOpen(true))
    return () => { unlisten.then((f) => f()) }
  }, [])

  useEffect(() => {
    bindScene(sceneRef.current)
    return () => bindScene(null)
  })

  const handleVolumeChange = useCallback((v: number) => {
    setVolume(v)
    LipSync.getInstance().setVolume(v)
    sceneRef.current?.setBgmVolume(v)
    saveSettings({ volume: v })
  }, [])

  const handleTrackingChange = useCallback((mode: 'mouse' | 'camera') => {
    sceneRef.current?.setTrackingMode(mode)
    setTracking(mode)
    saveSettings({ tracking: mode })
  }, [])

  const handleVrmMessage: OnVrmMessage = useCallback((msg) => {
    if (msg.emotion && sceneRef.current) {
      const action = emotionActionMap[msg.emotion]
      console.log('[App] emotion:', msg.emotion, '→ action:', action)
      if (msg.text) {
        // 回复消息：表情和动作同时触发（文字出现1s后由TextBubble延迟调用）
        sceneRef.current.setEmotionWithReset(msg.emotion, msg.emotionDuration ?? 5000, msg.emotionIntensity)
        if (action) sceneRef.current.playAction(action)
      } else {
        // 思考阶段：hold 动作，10s 后自动 reset
        sceneRef.current.setEmotionWithReset(msg.emotion, msg.emotionDuration ?? 10000, msg.emotionIntensity)
        if (action) sceneRef.current.playAction(action, true)
      }
    }
  }, [])

  // ── Idle fidget: random emotion + action every ~60s when idle ──────────────
  const lastActivityRef = useRef(Date.now())
  // Reset idle timer whenever a VRM message arrives
  const originalHandleVrmMessage = handleVrmMessage
  const handleVrmMessageWithActivity: OnVrmMessage = useCallback((msg) => {
    lastActivityRef.current = Date.now()
    originalHandleVrmMessage(msg)
  }, [originalHandleVrmMessage])

  useEffect(() => {
    const allEmotions = [
      'happy', 'sad', 'angry', 'surprised', 'think', 'awkward',
      'question', 'curious', 'neutral', 'love', 'flirty', 'greeting', 'relaxed',
    ]
    const allActions = [
      'akimbo', 'playFingers', 'scratchHead', 'stretch',
      'happy', 'angry', 'greeting', 'excited', 'shy',
      'point', 'salute', 'angryPump',
    ]
    const IDLE_THRESHOLD_MS = 30_000
    const FIDGET_CHECK_MS = 15_000 // check every 15s, randomness inside

    const timer = setInterval(() => {
      const idleMs = Date.now() - lastActivityRef.current
      if (idleMs < IDLE_THRESHOLD_MS) return
      // 50% chance each check to avoid being too predictable
      if (Math.random() > 0.5) return

      const emotion = allEmotions[Math.floor(Math.random() * allEmotions.length)]
      const action = allActions[Math.floor(Math.random() * allActions.length)]
      const intensity = 0.4 + Math.random() * 0.4 // 0.4–0.8
      sceneRef.current?.setEmotionWithReset(emotion, 3000 + Math.random() * 2000, intensity)
      sceneRef.current?.playAction(action)
      lastActivityRef.current = Date.now() // reset so we don't spam
    }, FIDGET_CHECK_MS)

    return () => clearInterval(timer)
  }, [])

  // ── Dancing mood boost: +1 every 30s ─────────
  useEffect(() => {
    if (!dancing) return
    const timer = setInterval(() => {
      fetch(`${OPENCLAW_URL}/plugins/claw-sama/mood/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta: 1, max: 90 }),
      }).catch(() => {})
    }, 30_000)
    return () => clearInterval(timer)
  }, [dancing])

  // ── Screen observation: capture desktop & send to LLM periodically ─────────
  useEffect(() => {
    if (!screenObserve) return
    const intervalMs = screenObserveInterval * 1000

    const doObserve = () => {
      fetch(`${OPENCLAW_URL}/plugins/claw-sama/screen/observe`, { method: 'POST' })
        .catch(() => {})
    }

    const timer = setInterval(doObserve, intervalMs)
    // Also fire once immediately on enable
    doObserve()

    return () => clearInterval(timer)
  }, [screenObserve, screenObserveInterval])

  // Capture VRM screenshot and upload to server (debounced to avoid duplicates)
  const screenshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const uploadVrmScreenshot = useCallback(() => {
    if (screenshotTimer.current) clearTimeout(screenshotTimer.current)
    screenshotTimer.current = setTimeout(() => {
      screenshotTimer.current = null
      const dataUrl = sceneRef.current?.captureScreenshot()
      if (!dataUrl) return
      fetch(`${OPENCLAW_URL}/plugins/claw-sama/persona/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
      }).catch(() => {})
    }, 500)
  }, [])

  const clearContext = async () => {
    try {
      await fetch(`${OPENCLAW_URL}/plugins/claw-sama/context/clear`, { method: 'POST' })
    } catch { /* ignore */ }
  }

  // 全局快捷键: Tab 展开/折叠菜单
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'Tab') {
        e.preventDefault()
        setCollapsed((v) => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // ── Touch interaction: immediate reaction + verbal response ──────────
  // Each region has multiple possible reactions, randomly selected (from lobe-vidol female defaults)
  const touchReactions: Record<TouchRegion, { emotion: string; action?: string }[]> = {
    head: [
      { emotion: 'relaxed', action: 'happy' },
      { emotion: 'relaxed', action: 'shy' },
      { emotion: 'relaxed', action: 'happy' },
      { emotion: 'relaxed', action: 'shy' },
      { emotion: 'angry', action: 'angryPump' },
      { emotion: 'relaxed', action: 'excited' },
    ],
    arm: [
      { emotion: 'surprised', action: 'excited' },
      { emotion: 'happy', action: 'happy' },
      { emotion: 'relaxed', action: 'greeting' },
      { emotion: 'relaxed', action: 'salute' },
      { emotion: 'relaxed', action: 'akimbo' },
    ],
    chest: [
      { emotion: 'angry', action: 'angryPump' },
      { emotion: 'angry', action: 'angry' },
      { emotion: 'angry', action: 'point' },
    ],
    belly: [
      { emotion: 'angry', action: 'angryPump' },
      { emotion: 'angry', action: 'angry' },
      { emotion: 'awkward', action: 'playFingers' },
      { emotion: 'angry', action: 'akimbo' },
    ],
    buttocks: [
      { emotion: 'angry', action: 'angryPump' },
      { emotion: 'angry', action: 'point' },
      { emotion: 'sad', action: 'shy' },
    ],
    leg: [
      { emotion: 'sad', action: 'shy' },
      { emotion: 'angry', action: 'angry' },
      { emotion: 'angry', action: 'point' },
      { emotion: 'angry', action: 'angryPump' },
      { emotion: 'awkward', action: 'playFingers' },
    ],
  }

  const regionLabels: Record<TouchRegion, string> = language === 'en'
    ? { head: 'head', arm: 'arm', chest: 'chest', belly: 'belly', buttocks: 'buttocks', leg: 'leg' }
    : { head: '头', arm: '手臂', chest: '胸', belly: '肚子', buttocks: '屁股', leg: '腿' }

  const handleTouch = useCallback((region: TouchRegion) => {
    const reactions = touchReactions[region]
    if (!reactions?.length) return
    const visual = reactions[Math.floor(Math.random() * reactions.length)]

    // Immediate visual feedback (always)
    lastActivityRef.current = Date.now()
    sceneRef.current?.setEmotionWithReset(visual.emotion, 3000, 0.8)
    if (visual.action) sceneRef.current?.playAction(visual.action)

    const now = Date.now()
    const prompt = language === 'en'
      ? `[The user touched your ${regionLabels[region]}]`
      : `[用户摸了摸你的${regionLabels[region]}]`

    // Always write to session history (3s cooldown)
    if (now - lastTouchMemoTime > TOUCH_MEMO_COOLDOWN) {
      lastTouchMemoTime = now
      fetch(`${OPENCLAW_URL}/plugins/claw-sama/session/memo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: prompt }),
      }).catch(() => {})
    }

    // Send to backend for verbal response (60s cooldown, 50% chance)
    if (now - lastTouchChatTime > TOUCH_CHAT_COOLDOWN && Math.random() < 0.5) {
      lastTouchChatTime = now
      fetch(`${OPENCLAW_URL}/plugins/claw-sama/touch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region, prompt }),
      }).catch(() => {})
    }
  }, [])

  const togglePin = async () => {
    const win = getCurrentWindow()
    const next = !pinned
    await win.setAlwaysOnTop(next)
    setPinned(next)
  }

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: 'transparent',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <ResizeHandles />
      <VRMScene ref={sceneRef} modelPath={modelPath} onTouch={handleTouch} onModelLoaded={uploadVrmScreenshot} />
      {!hideMood && <MoodIndicator uiAlign={uiAlign} />}
      <TextBubble onMessage={handleVrmMessageWithActivity} enabled={showText} ttsEnabled={ttsEnabled} />
      {!hideUI && <ChatInput uiAlign={uiAlign} onHistoryOpen={() => setHistoryOpen(true)} onNewSession={clearContext} language={language} />}
      <HistoryPanel
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        language={language}
      />
      <SettingsPanel
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        currentModel={modelPath}
        onModelChange={(m) => { setModelPath(m); setDancing(false); saveSettings({ modelPath: m }) }}
        hideUI={hideUI}
        onHideUIChange={(v) => { setHideUI(v); saveSettings({ hideUI: v }) }}
        showText={showText}
        onShowTextChange={(v) => { setShowText(v); saveSettings({ showText: v }) }}
        ttsEnabled={ttsEnabled}
        onTtsEnabledChange={(v) => { setTtsEnabled(v); saveSettings({ ttsEnabled: v }) }}
        tracking={tracking}
        onTrackingChange={handleTrackingChange}
        volume={volume}
        onVolumeChange={handleVolumeChange}
        uiAlign={uiAlign}
        onUiAlignChange={(v) => { setUiAlign(v); saveSettings({ uiAlign: v }) }}
        hideMood={hideMood}
        onHideMoodChange={(v) => { setHideMood(v); saveSettings({ hideMood: v }) }}
        screenObserve={screenObserve}
        onScreenObserveChange={(v) => { setScreenObserve(v); saveSettings({ screenObserve: v }) }}
        screenObserveInterval={screenObserveInterval}
        onScreenObserveIntervalChange={(v) => { setScreenObserveInterval(v); saveSettings({ screenObserveInterval: v }) }}
        captureVrmScreenshot={() => sceneRef.current?.captureScreenshot() ?? null}
        language={language}
        onLanguageChange={(v) => { setLanguage(v); saveSettings({ language: v }) }}
        currentDance={currentDance}
        onDanceChange={(id, preset) => {
          setCurrentDance(id)
          setCustomDancePreset(preset)
          saveSettings({ currentDance: id, customDancePreset: preset })
        }}
      />
      {!hideUI && <div
        style={{
          position: 'absolute',
          top: 8,
          ...(uiAlign === 'left' ? { left: 8 } : { right: 8 }),
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <button
          onClick={() => setCollapsed((v) => !v)}
          style={btnStyle}
          title={collapsed ? t('展开菜单 (Tab)', 'Expand Menu (Tab)') : t('折叠菜单 (Tab)', 'Collapse Menu (Tab)')}
        >
          <Menu size={16} />
        </button>
        {!collapsed && <>
          <button
            onClick={() => setSettingsOpen(true)}
            style={btnStyle}
            title={t('设置', 'Settings')}
          >
            <Settings size={16} />
          </button>
          <button
            onClick={() => getCurrentWindow().hide()}
            style={btnStyle}
            title={t('隐藏窗口', 'Hide Window')}
          >
            <EyeOff size={16} />
          </button>
          <button
            onClick={togglePin}
            style={{ ...btnStyle, opacity: pinned ? 1 : 0.5 }}
            title={pinned ? t('取消置顶', 'Unpin') : t('置顶窗口', 'Pin to Top')}
          >
            <Pin size={16} />
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              ;(window as any).__clawDragging = true
              let lastX = e.clientX
              let lastY = e.clientY
              const onMove = (ev: MouseEvent) => {
                sceneRef.current?.panCamera(ev.clientX - lastX, ev.clientY - lastY)
                lastX = ev.clientX
                lastY = ev.clientY
              }
              const onUp = () => {
                ;(window as any).__clawDragging = false
                window.removeEventListener('mousemove', onMove)
                window.removeEventListener('mouseup', onUp)
              }
              window.addEventListener('mousemove', onMove)
              window.addEventListener('mouseup', onUp)
            }}
            style={{ ...btnStyle, cursor: 'grab' }}
            title={t('拖动移动人物位置', 'Drag to Move')}
          >
            <Move size={16} />
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              ;(window as any).__clawDragging = true
              let lastX = e.clientX
              let lastY = e.clientY
              const onMove = (ev: MouseEvent) => {
                sceneRef.current?.rotateCamera(ev.clientX - lastX, ev.clientY - lastY)
                lastX = ev.clientX
                lastY = ev.clientY
              }
              const onUp = () => {
                ;(window as any).__clawDragging = false
                window.removeEventListener('mousemove', onMove)
                window.removeEventListener('mouseup', onUp)
              }
              window.addEventListener('mousemove', onMove)
              window.addEventListener('mouseup', onUp)
            }}
            style={{ ...btnStyle, cursor: 'grab' }}
            title={t('拖动旋转视角', 'Drag to Rotate')}
          >
            <Rotate3D size={16} />
          </button>
          <button
            onClick={() => { sceneRef.current?.reset(); setDancing(false) }}
            style={btnStyle}
            title={t('重置视角', 'Reset View')}
          >
            <RotateCcw size={16} />
          </button>
          <button
            onClick={() => {
              if (dancing) {
                sceneRef.current?.reset()
                setDancing(false)
              } else {
                const label = currentDance.startsWith('custom:') && customDancePreset
                  ? customDancePreset.label
                  : dancePresets[currentDance]?.label ?? currentDance
                if (currentDance.startsWith('custom:') && customDancePreset) {
                  sceneRef.current?.playDance(customDancePreset)
                } else {
                  sceneRef.current?.playDance(currentDance)
                }
                setDancing(true)
                // Record dance event in session history (no LLM reply)
                fetch(`${OPENCLAW_URL}/plugins/claw-sama/session/memo`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: `[用户邀请你跳了一支舞:${label}]` }),
                }).catch(() => {})
              }
            }}
            style={{
              ...btnStyle,
              ...(dancing ? { background: 'rgba(34, 197, 94, 0.6)' } : {}),
            }}
            title={dancing ? t('停止跳舞', 'Stop Dance') : t('跳舞', 'Dance')}
          >
            <Music size={16} />
          </button>
        </>}
      </div>}
    </div>
  )
}
