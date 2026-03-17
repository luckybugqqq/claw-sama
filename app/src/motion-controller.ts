/**
 * MotionController — unified animation system supporting VRMA, VMD, and FBX.
 *
 * Manages loading, caching, crossfading, and playback of body animations
 * on a VRM model via Three.js AnimationMixer.
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation'
import type { VRMAnimation } from '@pixiv/three-vrm-animation'
import type { VRM } from '@pixiv/three-vrm'
import { parseVMDAnimation, bindVMDToVRM } from './vmd-loader'
import type { VMDAnimationData } from './vmd-loader'
import { loadMixamoAnimation } from './mixamo-loader'
import { VRMIKHandler } from './vrm-ik-handler'

// ── Motion file types ───────────────────────────────────────────────────────

export type MotionFileType = 'vrma' | 'vmd' | 'fbx'

// ── Motion presets ──────────────────────────────────────────────────────────

export interface MotionPreset {
  label: string
  type: MotionFileType
  url: string
}

// Actions: short one-shot gestures triggered by emotions / interactions
export const actionPresets: Record<string, MotionPreset> = {
  // Local VRMA actions (bundled)
  akimbo:       { label: '叉腰',   type: 'vrma', url: '/akimbo.vrma' },
  playFingers:  { label: '搓手',   type: 'vrma', url: '/playFingers.vrma' },
  scratchHead:  { label: '挠头',   type: 'vrma', url: '/scratchHead.vrma' },
  stretch:      { label: '伸展',   type: 'vrma', url: '/stretch.vrma' },

  // Local FBX actions (bundled)
  happy:        { label: '开心',     type: 'fbx', url: '/happy.fbx' },
  angry:        { label: '生气',     type: 'fbx', url: '/angry.fbx' },
  greeting:     { label: '招呼',     type: 'fbx', url: '/greeting.fbx' },
  excited:      { label: '兴奋',     type: 'fbx', url: '/excited.fbx' },
  shy:          { label: '害羞',     type: 'fbx', url: '/shy.fbx' },
  point:        { label: '指点',     type: 'fbx', url: '/point.fbx' },
  salute:       { label: '敬礼',     type: 'fbx', url: '/salute.fbx' },
  angryPump:    { label: '暴怒',     type: 'fbx', url: '/angryPump.fbx' },
}

// Dances: looping full-body animations with optional BGM
export interface DancePreset extends MotionPreset {
  bgm?: string
}

export const dancePresets: Record<string, DancePreset> = {
  jile: { label: '极乐净土', type: 'vmd', url: '/jile.vmd', bgm: '/jile.mp3' },
  love: { label: '恋爱循环', type: 'vmd', url: '/love.vmd', bgm: '/love.mp3' },
}

// ── Utility: re-anchor root position ────────────────────────────────────────

function reAnchorRootPositionTrack(clip: THREE.AnimationClip, vrm: VRM) {
  const hipNode = vrm.humanoid?.getNormalizedBoneNode('hips')
  if (!hipNode) return

  hipNode.updateMatrixWorld(true)
  const defaultHipPos = new THREE.Vector3()
  hipNode.getWorldPosition(defaultHipPos)

  const hipsTrack = clip.tracks.find(
    (t) =>
      t instanceof THREE.VectorKeyframeTrack &&
      t.name === `${hipNode.name}.position`,
  )
  if (!(hipsTrack instanceof THREE.VectorKeyframeTrack)) return

  const animeHipPos = new THREE.Vector3(
    hipsTrack.values[0],
    hipsTrack.values[1],
    hipsTrack.values[2],
  )
  const delta = new THREE.Vector3().subVectors(animeHipPos, defaultHipPos)

  clip.tracks.forEach((track) => {
    if (
      track.name.endsWith('.position') &&
      track instanceof THREE.VectorKeyframeTrack
    ) {
      for (let i = 0; i < track.values.length; i += 3) {
        track.values[i] -= delta.x
        track.values[i + 1] -= delta.y
        track.values[i + 2] -= delta.z
      }
    }
  })
}

// ── MotionController ────────────────────────────────────────────────────────

export class MotionController {
  private vrm: VRM
  private mixer: THREE.AnimationMixer
  private idleAction: THREE.AnimationAction | null = null
  private currentAction: THREE.AnimationAction | null = null
  private clipCache = new Map<string, THREE.AnimationClip>()
  private vmdDataCache = new Map<string, VMDAnimationData>()
  private gltfLoader: GLTFLoader
  private ikHandler: VRMIKHandler
  private _isDancing = false
  private _actionPlaying = false
  private _ikActive = false
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private _actionSafetyTimer: ReturnType<typeof setTimeout> | null = null
  private bgmAudio: HTMLAudioElement | null = null

  // Callbacks for external coordination (camera switching etc.)
  onDanceStart?: () => void
  onDanceStop?: () => void

  constructor(vrm: VRM, mixer: THREE.AnimationMixer) {
    this.vrm = vrm
    this.mixer = mixer
    this.gltfLoader = new GLTFLoader()
    this.gltfLoader.register((parser) => new VRMAnimationLoaderPlugin(parser))
    this.ikHandler = VRMIKHandler.get(vrm)
  }

  private _volume = 1

  get isDancing() { return this._isDancing }
  get actionPlaying() { return this._actionPlaying }

  /** Set BGM volume (0–1). Also applies to currently playing BGM. */
  setVolume(v: number) {
    this._volume = v
    if (this.bgmAudio) this.bgmAudio.volume = v
  }

  update(delta: number) {
    this.mixer.update(delta)
    if (this._ikActive) this.ikHandler.update()
  }

  // ── Load idle animation ─────────────────────────────────────────────────

  async loadIdle(path: string) {
    const clip = await this.loadVRMA(path)
    if (!clip) return
    reAnchorRootPositionTrack(clip, this.vrm)
    this.idleAction = this.mixer.clipAction(clip)
    this.idleAction.play()
  }

  // ── Play a one-shot action ──────────────────────────────────────────────

  async playAction(name: string, hold = false) {
    console.log('[Motion] playAction:', name, { isDancing: this._isDancing, actionPlaying: this._actionPlaying })
    if (this._isDancing || this._actionPlaying) return

    const preset = actionPresets[name]
    if (!preset) { console.warn('[Motion] unknown action:', name); return }

    console.log('[Motion] loading clip:', preset.type, preset.url)
    const clip = await this.loadClip(preset)
    if (!clip) { console.warn('[Motion] clip load failed for:', name); return }
    console.log('[Motion] playing:', name)

    this.releaseHeld()
    this._actionPlaying = true

    const action = this.mixer.clipAction(clip)
    action.reset()
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = hold

    if (hold) {
      this.idleAction?.stop()
      action.play()
    } else {
      if (this.idleAction) action.crossFadeFrom(this.idleAction, 0.3, true)
      action.play()
    }

    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      this.mixer.removeEventListener('finished', onFinished)
      if (this._actionSafetyTimer) { clearTimeout(this._actionSafetyTimer); this._actionSafetyTimer = null }
      if (hold) {
        this.currentAction = action
        this.holdTimer = setTimeout(() => this.releaseHeld(), 10000)
      } else {
        action.stop()
        this.idleAction?.reset().play()
        this._actionPlaying = false
        this.disableIK()
      }
    }
    const onFinished = () => settle()
    this.mixer.addEventListener('finished', onFinished)

    // Safety timeout: guarantee _actionPlaying resets even if 'finished' never fires
    const duration = clip.duration > 0 ? clip.duration : 3
    this._actionSafetyTimer = setTimeout(() => settle(), (duration + 1) * 1000)
  }

  // ── Dance (looping VMD/FBX/VRMA) ───────────────────────────────────────

  async playDance(nameOrPreset: string | DancePreset) {
    if (this._isDancing) return
    this._isDancing = true

    try {
      // Accept preset name, URL, or full DancePreset object
      const preset: DancePreset | undefined =
        typeof nameOrPreset === 'object' ? nameOrPreset : dancePresets[nameOrPreset]
      const clip = preset
        ? await this.loadClip(preset)
        : await this.loadClipByUrl(nameOrPreset as string)

      if (!clip) {
        this._isDancing = false
        return
      }

      this.releaseHeld()
      this.idleAction?.stop()

      this.onDanceStart?.()

      // Play BGM if preset has one (stop any lingering audio first)
      this.stopBgmImmediate()
      if (preset?.bgm) {
        this.bgmAudio = new Audio(preset.bgm)
        this.bgmAudio.loop = true
        this.bgmAudio.volume = this._volume
        this.bgmAudio.play().catch(() => {})
      }

      this.currentAction = this.mixer.clipAction(clip)
      this.currentAction.reset()
      this.currentAction.setLoop(THREE.LoopRepeat, Infinity)
      this.currentAction.play()
    } catch (err) {
      console.error('Failed to start dance:', err)
      this._isDancing = false
    }
  }

  stopDance() {
    // Always stop BGM regardless of dance state
    this.stopBgm()

    if (!this._isDancing) return
    this._isDancing = false

    if (this.currentAction) {
      this.currentAction.fadeOut(0.5)
      const action = this.currentAction
      this.currentAction = null
      setTimeout(() => {
        action.stop()
        this.idleAction?.reset().play()
        this.disableIK()
      }, 500)
    } else {
      this.disableIK()
    }

    this.onDanceStop?.()
  }

  /** Stop BGM with fade-out. Safe to call anytime. */
  private stopBgm() {
    if (!this.bgmAudio) return
    const audio = this.bgmAudio
    this.bgmAudio = null
    const fadeInterval = setInterval(() => {
      audio.volume = Math.max(0, audio.volume - 0.1)
      if (audio.volume <= 0) {
        clearInterval(fadeInterval)
        audio.pause()
      }
    }, 50)
  }

  /** Stop BGM instantly without fade. Used to prevent duplicate playback. */
  private stopBgmImmediate() {
    if (!this.bgmAudio) return
    this.bgmAudio.pause()
    this.bgmAudio = null
  }

  /** Cleanup when controller is being destroyed (model reload etc.) */
  dispose() {
    this.stopBgm()
    this.disableIK()
    this._isDancing = false
    this._actionPlaying = false
    if (this.currentAction) {
      this.currentAction.stop()
      this.currentAction = null
    }
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null }
    if (this._actionSafetyTimer) { clearTimeout(this._actionSafetyTimer); this._actionSafetyTimer = null }
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private releaseHeld() {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null }
    if (this.currentAction) {
      this.currentAction.stop()
      this.currentAction = null
      this.idleAction?.reset().play()
      this._actionPlaying = false
      this.disableIK()
    }
  }

  private disableIK() {
    if (this._ikActive) {
      this._ikActive = false
      this.ikHandler.disableAll()
    }
  }

  private async loadClip(preset: MotionPreset): Promise<THREE.AnimationClip | null> {
    // For VMD, always rebuild clip with IK binding (IK targets are per-play)
    if (preset.type === 'vmd') {
      return this.loadVMDWithIK(preset.url)
    }

    const cached = this.clipCache.get(preset.url)
    if (cached) return cached

    let clip: THREE.AnimationClip | null = null

    try {
      switch (preset.type) {
        case 'vrma':
          clip = await this.loadVRMA(preset.url)
          if (clip) reAnchorRootPositionTrack(clip, this.vrm)
          break
        case 'fbx':
          clip = await loadMixamoAnimation(preset.url, this.vrm)
          break
      }
    } catch (err) {
      console.error('Failed to load clip:', preset.url, err)
      return null
    }

    if (clip) {
      clip.name = preset.url
      this.clipCache.set(preset.url, clip)
    }
    return clip
  }

  private async loadVMDWithIK(url: string): Promise<THREE.AnimationClip | null> {
    try {
      // Cache parsed VMD data (parsing is expensive), but rebuild clip each time
      // because IK binding creates unique target objects per play
      let data = this.vmdDataCache.get(url)
      if (!data) {
        data = await parseVMDAnimation(url, this.vrm)
        this.vmdDataCache.set(url, data)
      }
      const clip = bindVMDToVRM(data, this.vrm, this.ikHandler)
      this._ikActive = true
      return clip
    } catch (err) {
      console.error('Failed to load VMD:', url, err)
      return null
    }
  }

  private async loadClipByUrl(url: string): Promise<THREE.AnimationClip | null> {
    const ext = url.split('.').pop()?.toLowerCase()
    const type: MotionFileType =
      ext === 'vmd' ? 'vmd' :
      ext === 'fbx' ? 'fbx' : 'vrma'
    return this.loadClip({ label: url, type, url })
  }

  private async loadVRMA(url: string): Promise<THREE.AnimationClip | null> {
    try {
      const gltf = await this.gltfLoader.loadAsync(url)
      const anims = gltf.userData.vrmAnimations as VRMAnimation[]
      if (anims?.length) {
        return createVRMAnimationClip(anims[0], this.vrm)
      }
    } catch (err) {
      console.warn(`Failed to load VRMA: ${url}`, err)
    }
    return null
  }
}
