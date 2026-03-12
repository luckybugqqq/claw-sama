import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Play, Loader, Sparkles } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'

interface SettingsPanelProps {
  visible: boolean
  onClose: () => void
  currentModel: string
  onModelChange: (path: string) => void
  hideUI: boolean
  onHideUIChange: (v: boolean) => void
  showText: boolean
  onShowTextChange: (v: boolean) => void
  ttsEnabled: boolean
  onTtsEnabledChange: (v: boolean) => void
  tracking: 'mouse' | 'camera'
  onTrackingChange: (v: 'mouse' | 'camera') => void
  volume: number
  onVolumeChange: (v: number) => void
  uiAlign: 'left' | 'right'
  onUiAlignChange: (v: 'left' | 'right') => void
  screenObserve: boolean
  onScreenObserveChange: (v: boolean) => void
  /** Return a data URL screenshot of the current VRM canvas */
  captureVrmScreenshot?: () => string | null
}

type Tab = 'general' | 'voice' | 'model' | 'persona'

const OPENCLAW_URL = 'http://127.0.0.1:18789'
const BUILTIN_MODELS = ['/model1.vrm', '/model2.vrm', '/model3.vrm', '/model4.vrm']

const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 (女)' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓依 (女)' },
  { id: 'zh-CN-YunxiNeural', label: '云希 (男)' },
  { id: 'zh-CN-YunjianNeural', label: '云健 (男)' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵 (女)' },
  { id: 'zh-CN-XiaomoNeural', label: '晓墨 (女)' },
  { id: 'zh-CN-XiaoxuanNeural', label: '晓萱 (女)' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 (男)' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 (女)' },
  { id: 'ja-JP-NanamiNeural', label: 'Nanami (女)' },
  { id: 'en-US-MichelleNeural', label: 'Michelle (F)' },
  { id: 'en-US-GuyNeural', label: 'Guy (M)' },
]

const QWEN_VOICES = [
  { id: 'Cherry', label: '芊悦 - 阳光亲切 (女)' },
  { id: 'Serena', label: '苏瑶 - 温柔 (女)' },
  { id: 'Ethan', label: '晨煦 - 阳光温暖 (男)' },
  { id: 'Chelsie', label: '千雪 - 二次元 (女)' },
  { id: 'Momo', label: '茉兔 - 撒娇搞怪 (女)' },
  { id: 'Vivian', label: '十三 - 可爱小暴躁 (女)' },
  { id: 'Moon', label: '月白 - 率性帅气 (男)' },
  { id: 'Maia', label: '四月 - 知性温柔 (女)' },
  { id: 'Kai', label: '凯 - 耳朵SPA (男)' },
  { id: 'Nofish', label: '不吃鱼 - 设计师 (男)' },
  { id: 'Bella', label: '萌宝 - 小萝莉 (女)' },
  { id: 'Mia', label: '乖小妹 - 温顺乖巧 (女)' },
  { id: 'Mochi', label: '沙小弥 - 童真小大人 (男)' },
  { id: 'Bunny', label: '萌小姬 - 萌属性 (女)' },
  { id: 'Nini', label: '邻家妹妹 - 软糯甜蜜 (女)' },
  { id: 'Stella', label: '少女阿月 - 迷糊少女 (女)' },
  { id: 'Pip', label: '顽屁小孩 - 调皮捣蛋 (男)' },
  { id: 'Neil', label: '阿闻 - 新闻主持 (男)' },
  { id: 'Eldric Sage', label: '沧明子 - 沉稳老者 (男)' },
  { id: 'Vincent', label: '田叔 - 沙哑烟嗓 (男)' },
  { id: 'Bellona', label: '燕铮莺 - 有声书 (女)' },
  { id: 'Seren', label: '小婉 - 温柔助眠 (女)' },
]

const QWEN_MODELS = [
  { id: 'qwen3-tts-flash', label: '千问3 TTS Flash' },
  { id: 'qwen3-tts-instruct-flash', label: '千问3 TTS Instruct Flash (指令控制)' },
]

export function SettingsPanel({
  visible, onClose, currentModel, onModelChange,
  hideUI, onHideUIChange,
  showText, onShowTextChange,
  ttsEnabled, onTtsEnabledChange,
  tracking, onTrackingChange,
  volume, onVolumeChange,
  uiAlign, onUiAlignChange,
  screenObserve, onScreenObserveChange,
  captureVrmScreenshot,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<Tab>('general')
  const [models, setModels] = useState<string[]>([])
  const [soulContent, setSoulContent] = useState('')
  const [identityContent, setIdentityContent] = useState('')
  const [personaDirty, setPersonaDirty] = useState(false)
  const [personaSaving, setPersonaSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [currentVoice, setCurrentVoice] = useState('')
  const [currentProvider, setCurrentProvider] = useState<string>('edge')
  const [qwenKey, setQwenKey] = useState('')
  const [qwenModel, setQwenModel] = useState('qwen3-tts-flash')
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Force disable pass-through when panel is visible
  useEffect(() => {
    if (!visible) return
    const win = getCurrentWindow()
    win.setIgnoreCursorEvents(false)
    // Keep forcing it in case of race conditions with cursor monitor
    const interval = setInterval(() => win.setIgnoreCursorEvents(false), 200)
    return () => clearInterval(interval)
  }, [visible])

  useEffect(() => {
    if (!visible) return
    fetch(`${OPENCLAW_URL}/plugins/claw-sama/model/list`)
      .then((r) => r.json())
      .then((data) => { if (data.models) setModels(data.models) })
      .catch(() => setModels([]))
    // Fetch current voice + provider
    fetch(`${OPENCLAW_URL}/plugins/claw-sama/voice`)
      .then((r) => r.json())
      .then((data) => {
        setCurrentVoice(data.voice || '')
        setCurrentProvider(data.provider || 'edge')
        if (data.qwenKey) setQwenKey(data.qwenKey)
        if (data.qwenModel) setQwenModel(data.qwenModel)
      })
      .catch(() => {})
  }, [visible])

  // Fetch persona files when model tab / persona sub-tab is active
  useEffect(() => {
    if (!visible || tab !== 'persona') return
    fetch(`${OPENCLAW_URL}/plugins/claw-sama/persona`)
      .then((r) => r.json())
      .then((data) => {
        setSoulContent(data.soul || '')
        setIdentityContent(data.identity || '')
        setPersonaDirty(false)
      })
      .catch(() => {})
  }, [visible, tab])

  const savePersona = useCallback(() => {
    setPersonaSaving(true)
    fetch(`${OPENCLAW_URL}/plugins/claw-sama/persona`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soul: soulContent, identity: identityContent }),
    })
      .then(() => { setPersonaDirty(false) })
      .catch(() => {})
      .finally(() => setPersonaSaving(false))
  }, [soulContent, identityContent])

  const generatePersona = useCallback(async () => {
    if (!captureVrmScreenshot) return
    const dataUrl = captureVrmScreenshot()
    if (!dataUrl) return
    setGenerating(true)
    try {
      // Save screenshot to server first
      const saveRes = await fetch(`${OPENCLAW_URL}/plugins/claw-sama/persona/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
      })
      const saveData = await saveRes.json()
      if (!saveData.ok) throw new Error(saveData.error || 'save screenshot failed')
      // Generate persona from saved screenshot
      const genRes = await fetch(`${OPENCLAW_URL}/plugins/claw-sama/persona/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const genData = await genRes.json()
      if (genData.soul || genData.identity) {
        if (genData.soul) setSoulContent(genData.soul)
        if (genData.identity) setIdentityContent(genData.identity)
        setPersonaDirty(true)
      }
    } catch { /* ignore */ }
    setGenerating(false)
  }, [captureVrmScreenshot])

  const postVoiceSettings = (body: Record<string, string | undefined>) => {
    return fetch(`${OPENCLAW_URL}/plugins/claw-sama/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  const saveModelPath = (modelPath: string) => {
    fetch(`${OPENCLAW_URL}/plugins/claw-sama/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPath }),
    }).catch(() => {})
  }

  const setVoice = (voice: string) => {
    postVoiceSettings({ voice }).then(() => setCurrentVoice(voice)).catch(() => {})
  }

  const setProvider = (provider: string) => {
    postVoiceSettings({ provider }).then(() => setCurrentProvider(provider)).catch(() => {})
  }

  const saveQwenKey = (key: string) => {
    postVoiceSettings({ qwenKey: key }).catch(() => {})
  }

  const saveQwenModel = (model: string) => {
    postVoiceSettings({ qwenModel: model }).then(() => setQwenModel(model)).catch(() => {})
  }

  const stopPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.pause()
      audioRef.current = null
    }
    setPreviewingId(null)
  }, [])

  const preview = (voiceId: string) => {
    // Stop any current preview first
    stopPreview()
    setPreviewingId(voiceId)
    fetch(`${OPENCLAW_URL}/plugins/claw-sama/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: voiceId, provider: currentProvider }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.audioUrl) {
          const audio = new Audio(data.audioUrl)
          audioRef.current = audio
          audio.onended = () => stopPreview()
          audio.onerror = () => stopPreview()
          audio.play().catch(() => stopPreview())
        } else {
          if (data.error) console.warn('TTS preview error:', data.error)
          stopPreview()
        }
      })
      .catch(() => stopPreview())
  }

  if (!visible) return null

  const voices = currentProvider === 'qwen' ? QWEN_VOICES : EDGE_VOICES

  return (
    <div style={overlayStyle} data-no-passthrough onClick={onClose}>
      <div style={panelStyle} data-no-passthrough onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>设置</span>
          <button onClick={onClose} style={closeBtnStyle}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div style={tabBarStyle}>
          {(['general', 'voice', 'model', 'persona'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{ ...tabStyle, ...(tab === t ? activeTabStyle : {}) }}
            >
              {{ general: '常规', voice: '语音', model: '形象', persona: '人设' }[t]}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={contentStyle}>
          {tab === 'general' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <ToggleRow label="隐藏UI" value={hideUI} onChange={onHideUIChange} />
              <ToggleRow label="显示字幕" value={showText} onChange={onShowTextChange} />
              <ToggleRow label="语音播报" value={ttsEnabled} onChange={onTtsEnabledChange} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>音量</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(volume * 100)}
                    onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
                    style={{ width: 100, accentColor: 'rgba(100, 160, 255, 0.8)' }}
                  />
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', width: 28, textAlign: 'right' }}>{Math.round(volume * 100)}</span>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>视线跟随</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['mouse', 'camera'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => onTrackingChange(m)}
                      style={{
                        ...smallBtnStyle,
                        background: tracking === m ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                        borderColor: tracking === m ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                      }}
                    >
                      {m === 'mouse' ? '鼠标' : '镜头'}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14 }}>UI位置</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['left', 'right'] as const).map((a) => (
                    <button
                      key={a}
                      onClick={() => onUiAlignChange(a)}
                      style={{
                        ...smallBtnStyle,
                        background: uiAlign === a ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                        borderColor: uiAlign === a ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                      }}
                    >
                      {a === 'left' ? '靠左' : '靠右'}
                    </button>
                  ))}
                </div>
              </div>
              <ToggleRow label="屏幕观察" value={screenObserve} onChange={onScreenObserveChange} />
              {screenObserve && (
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: -8 }}>
                  每分钟截取屏幕，AI 会根据你在做什么主动跟你互动
                </div>
              )}
            </div>
          )}

          {tab === 'voice' && (
            <div style={sectionStyle}>
              <div style={labelStyle}>TTS 服务</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['edge', 'qwen'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setProvider(p)}
                    style={{
                      ...modelBtnStyle,
                      flex: 1,
                      textAlign: 'center',
                      padding: '6px 10px',
                      fontSize: 13,
                      background: p === currentProvider ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                      borderColor: p === currentProvider ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                    }}
                  >
                    {{ edge: 'Edge', qwen: '千问 TTS' }[p]}
                  </button>
                ))}
              </div>

              {currentProvider === 'qwen' && (
                <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>
                    <div style={labelStyle}>阿里云 API Key</div>
                    <input
                      type="text"
                      value={qwenKey}
                      onChange={(e) => setQwenKey(e.target.value)}
                      onBlur={() => saveQwenKey(qwenKey)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveQwenKey(qwenKey) }}
                      placeholder="sk-..."
                      style={{ ...inputStyle, width: '100%' }}
                    />
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 4 }}>
                      从阿里云百炼控制台获取 API Key
                    </div>
                  </div>
                  <div>
                    <div style={labelStyle}>语音模型</div>
                    <select
                      value={qwenModel}
                      onChange={(e) => { setQwenModel(e.target.value); saveQwenModel(e.target.value) }}
                      style={selectStyle}
                    >
                      {QWEN_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <div style={{ marginTop: 8 }}>
                <div style={labelStyle}>{currentProvider === 'qwen' ? '千问语音' : 'Edge TTS 语音'}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
                  {voices.map((v) => (
                    <div
                      key={v.id}
                      onClick={() => setVoice(v.id)}
                      style={{
                        ...modelBtnStyle,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 6px 6px 10px',
                        fontSize: 13,
                        background: v.id === currentVoice ? 'rgba(100, 160, 255, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                        borderColor: v.id === currentVoice ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
                      }}
                    >
                      <div>
                        <div>{v.label}</div>
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 1 }}>{v.id}</div>
                      </div>
                      <div
                        onClick={(e) => { e.stopPropagation(); preview(v.id) }}
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 6,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: previewingId === v.id ? 'rgba(100, 160, 255, 0.3)' : 'rgba(255, 255, 255, 0.08)',
                          cursor: previewingId !== null ? 'default' : 'pointer',
                          flexShrink: 0,
                          opacity: previewingId !== null && previewingId !== v.id ? 0.3 : 0.7,
                          transition: 'background 0.15s',
                        }}
                        title="试听"
                      >
                        {previewingId === v.id ? <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={13} />}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'model' && (
            <div style={sectionStyle}>
              <div style={labelStyle}>VRM模型</div>
              <select
                value={currentModel}
                onChange={(e) => { onModelChange(e.target.value); saveModelPath(e.target.value) }}
                style={selectStyle}
              >
                {BUILTIN_MODELS.map((m) => (
                  <option key={m} value={m}>{m.replace(/^\//, '')}</option>
                ))}
                {models.map((m) => (
                  <option key={m} value={m}>{decodeURIComponent(m.split('/').pop() || m)} (自定义)</option>
                ))}
              </select>

              <div style={{ marginTop: 12 }}>
                <div style={labelStyle}>导入自定义模型</div>
                <button
                  onClick={async () => {
                    const filePath = await invoke<string | null>('pick_vrm_file')
                    if (!filePath) return
                    try {
                      const res = await fetch(`${OPENCLAW_URL}/plugins/claw-sama/model/import`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: filePath }),
                      })
                      const data = await res.json()
                      if (data.url) {
                        // Refresh model list and select the new one
                        fetch(`${OPENCLAW_URL}/plugins/claw-sama/model/list`)
                          .then((r) => r.json())
                          .then((d) => { if (d.models) setModels(d.models) })
                          .catch(() => {})
                        onModelChange(data.url)
                        saveModelPath(data.url)
                      }
                    } catch (err) {
                      console.warn('Import model failed:', err)
                    }
                  }}
                  style={{ ...applyBtnStyle, width: '100%' }}
                >
                  浏览本地文件…
                </button>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 4 }}>
                  选择本地 .vrm 文件，将自动拷贝到内置模型目录
                </div>
              </div>
            </div>
          )}

          {tab === 'persona' && (
            <div style={sectionStyle}>
              <div style={labelStyle}>IDENTITY.md</div>
              <textarea
                value={identityContent}
                onChange={(e) => { setIdentityContent(e.target.value); setPersonaDirty(true) }}
                placeholder="角色身份信息（名字、种族、性格、emoji 等）…"
                style={textareaStyle}
                rows={4}
              />

              <div style={{ ...labelStyle, marginTop: 4 }}>SOUL.md</div>
              <textarea
                value={soulContent}
                onChange={(e) => { setSoulContent(e.target.value); setPersonaDirty(true) }}
                placeholder="角色灵魂设定（说话风格、行为准则、背景故事等）…"
                style={textareaStyle}
                rows={6}
              />

              <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
                <button
                  onClick={generatePersona}
                  disabled={generating || !captureVrmScreenshot}
                  style={{
                    ...applyBtnStyle,
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    background: generating ? 'rgba(100, 160, 255, 0.3)' : 'rgba(160, 120, 255, 0.5)',
                  }}
                  title="根据当前模型截图自动生成人设"
                >
                  {generating
                    ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
                    : <Sparkles size={14} />}
                  {generating ? '生成中…' : '一键生成人设'}
                </button>
                <button
                  onClick={savePersona}
                  disabled={!personaDirty || personaSaving}
                  style={{
                    ...applyBtnStyle,
                    opacity: personaDirty ? 1 : 0.4,
                  }}
                >
                  {personaSaving ? '保存中…' : '保存'}
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 4 }}>
                关联工作区根目录的 IDENTITY.md 和 SOUL.md
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 14 }}>{label}</span>
      <button
        onClick={() => onChange(!value)}
        style={{
          ...toggleStyle,
          background: value ? 'rgba(100, 160, 255, 0.6)' : 'rgba(255, 255, 255, 0.15)',
        }}
      >
        <div style={{
          ...toggleKnobStyle,
          transform: value ? 'translateX(18px)' : 'translateX(2px)',
        }} />
      </button>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: 'rgba(0, 0, 0, 0.5)',
  zIndex: 500,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
}

const panelStyle: React.CSSProperties = {
  width: 320,
  background: 'rgba(30, 30, 40, 0.95)',
  backdropFilter: 'blur(12px)',
  borderRadius: 12,
  border: '1px solid rgba(255, 255, 255, 0.15)',
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
  padding: 16,
  color: '#fff',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 12,
}

const closeBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  border: 'none',
  borderRadius: 6,
  background: 'rgba(255, 255, 255, 0.1)',
  color: 'rgba(255, 255, 255, 0.7)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 2,
  marginBottom: 16,
  background: 'rgba(255, 255, 255, 0.06)',
  borderRadius: 8,
  padding: 2,
}

const tabStyle: React.CSSProperties = {
  flex: 1,
  height: 32,
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'rgba(255, 255, 255, 0.6)',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
}

const activeTabStyle: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.12)',
  color: '#fff',
}

const contentStyle: React.CSSProperties = {
  minHeight: 120,
}

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'rgba(255, 255, 255, 0.6)',
  marginBottom: 2,
}

const toggleStyle: React.CSSProperties = {
  width: 40,
  height: 22,
  borderRadius: 11,
  border: 'none',
  cursor: 'pointer',
  position: 'relative',
  transition: 'background 0.2s',
  padding: 0,
}

const toggleKnobStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 9,
  background: '#fff',
  transition: 'transform 0.2s',
  position: 'absolute',
  top: 2,
}

const smallBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  border: '1px solid',
  borderRadius: 6,
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
}

const modelBtnStyle: React.CSSProperties = {
  padding: '8px 12px',
  border: '1px solid',
  borderRadius: 8,
  color: '#fff',
  fontSize: 14,
  cursor: 'pointer',
  textAlign: 'left',
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  height: 32,
  boxSizing: 'border-box',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 6,
  background: 'rgba(0, 0, 0, 0.3)',
  color: '#fff',
  fontSize: 13,
  padding: '0 8px',
  outline: 'none',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  height: 32,
  boxSizing: 'border-box',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 6,
  background: 'rgba(0, 0, 0, 0.3)',
  color: '#fff',
  fontSize: 13,
  padding: '0 8px',
  outline: 'none',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 6,
  background: 'rgba(0, 0, 0, 0.3)',
  color: '#fff',
  fontSize: 12,
  lineHeight: '1.5',
  padding: '6px 8px',
  outline: 'none',
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
  resize: 'vertical',
}

const applyBtnStyle: React.CSSProperties = {
  height: 32,
  padding: '0 12px',
  border: 'none',
  borderRadius: 6,
  background: 'rgba(100, 160, 255, 0.5)',
  color: '#fff',
  fontSize: 13,
  cursor: 'pointer',
}
