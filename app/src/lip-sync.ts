import type { VRM } from '@pixiv/three-vrm'
import type { Profile } from 'wlipsync'
import { createWLipSyncNode } from 'wlipsync'
import profile from './assets/lip-sync-profile.json'

type LipKey = 'A' | 'E' | 'I' | 'O' | 'U'
const RAW_KEYS = ['A', 'E', 'I', 'O', 'U', 'S'] as const
const LIP_KEYS: LipKey[] = ['A', 'E', 'I', 'O', 'U']
const BLENDSHAPE_MAP: Record<LipKey, string> = {
  A: 'aa',
  E: 'ee',
  I: 'ih',
  O: 'oh',
  U: 'ou',
}
const RAW_TO_LIP: Record<typeof RAW_KEYS[number], LipKey> = {
  A: 'A', E: 'E', I: 'I', O: 'O', U: 'U', S: 'I',
}

const ATTACK = 50
const RELEASE = 30
const CAP = 0.7
const SILENCE_VOL = 0.04
const SILENCE_GAIN = 0.05
const IDLE_MS = 160

let singleton: LipSync | null = null

export class LipSync {
  private audioContext: AudioContext | null = null
  private lipSyncNode: any = null
  private gainNode: GainNode | null = null
  private smoothState: Record<LipKey, number> = { A: 0, E: 0, I: 0, O: 0, U: 0 }
  private lastActiveAt = 0
  private currentSource: AudioBufferSourceNode | null = null
  private ready = false
  private initPromise: Promise<void> | null = null

  static getInstance(): LipSync {
    if (!singleton) singleton = new LipSync()
    return singleton
  }

  private constructor() {}

  private async ensureReady() {
    if (this.ready) return
    if (this.initPromise) return this.initPromise
    this.initPromise = (async () => {
      this.audioContext = new AudioContext()
      this.lipSyncNode = await createWLipSyncNode(this.audioContext, profile as Profile)
      // lipSyncNode is analysis-only, no need to connect to destination
      this.gainNode = this.audioContext.createGain()
      this.gainNode.connect(this.audioContext.destination)
      this.ready = true
    })()
    return this.initPromise
  }

  /**
   * Fetch audio from URL, decode it, and play through Web Audio API.
   * Returns duration (ms) once playback starts. Sound goes to both
   * lipSyncNode (for mouth analysis) and destination (for speakers).
   */
  async playAudio(url: string): Promise<number> {
    await this.ensureReady()
    if (!this.lipSyncNode || !this.audioContext) return 0

    // Stop previous source
    if (this.currentSource) {
      try { this.currentSource.stop() } catch {}
      try { this.currentSource.disconnect() } catch {}
      this.currentSource = null
    }

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }

    const response = await fetch(url)
    const arrayBuffer = await response.arrayBuffer()
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer)

    const source = this.audioContext.createBufferSource()
    source.buffer = audioBuffer
    source.connect(this.lipSyncNode)
    source.connect(this.gainNode!)
    this.currentSource = source
    source.start()

    return audioBuffer.duration * 1000
  }

  setVolume(value: number) {
    if (this.gainNode) {
      this.gainNode.gain.value = value
    }
  }

  update(vrm: VRM, delta: number) {
    const node = this.lipSyncNode
    if (!vrm.expressionManager || !node || !this.ready) return

    const vol = node.volume ?? 0
    const amp = Math.min(vol * 0.9, 1) ** 0.7

    const projected: Record<LipKey, number> = { A: 0, E: 0, I: 0, O: 0, U: 0 }
    for (const raw of RAW_KEYS) {
      const lip = RAW_TO_LIP[raw]
      const rawVal = node.weights[raw] ?? 0
      projected[lip] = Math.max(projected[lip], rawVal * amp)
    }

    let winner: LipKey = 'I'
    let runner: LipKey = 'E'
    let winnerVal = -Infinity
    let runnerVal = -Infinity
    for (const key of LIP_KEYS) {
      const val = projected[key]
      if (val > winnerVal) {
        runnerVal = winnerVal
        runner = winner
        winnerVal = val
        winner = key
      } else if (val > runnerVal) {
        runnerVal = val
        runner = key
      }
    }

    const now = performance.now()
    let silent = amp < SILENCE_VOL || winnerVal < SILENCE_GAIN
    if (!silent) this.lastActiveAt = now
    if (now - this.lastActiveAt > IDLE_MS) silent = true

    const target: Record<LipKey, number> = { A: 0, E: 0, I: 0, O: 0, U: 0 }
    if (!silent) {
      target[winner] = Math.min(CAP, winnerVal)
      target[runner] = Math.min(CAP * 0.5, runnerVal * 0.6)
    }

    for (const key of LIP_KEYS) {
      const from = this.smoothState[key]
      const to = target[key]
      const rate = 1 - Math.exp(-(to > from ? ATTACK : RELEASE) * delta)
      this.smoothState[key] = from + (to - from) * rate
      const weight = (this.smoothState[key] <= 0.01 ? 0 : this.smoothState[key]) * 0.7
      vrm.expressionManager.setValue(BLENDSHAPE_MAP[key], weight)
    }
  }

  dispose() {
    if (this.currentSource) {
      try { this.currentSource.disconnect() } catch {}
    }
    if (this.lipSyncNode) {
      try { this.lipSyncNode.disconnect() } catch {}
    }
    this.audioContext?.close()
    singleton = null
  }
}
