/**
 * MotionController — unified animation system supporting VRMA, VMD, and FBX.
 *
 * Uses a single persistent AnimationMixer with crossFade transitions to avoid
 * T-pose flickering between animations.
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
  private mixer: THREE.AnimationMixer | null = null
  private idleClip: THREE.AnimationClip | null = null
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

  constructor(vrm: VRM) {
    this.vrm = vrm
    this.mixer = new THREE.AnimationMixer(vrm.scene)
    this.gltfLoader = new GLTFLoader()
    this.gltfLoader.register((parser) => new VRMAnimationLoaderPlugin(parser))
    this.ikHandler = VRMIKHandler.get(vrm)
  }

  private _volume = 0.5

  get isDancing() { return this._isDancing }
  get actionPlaying() { return this._actionPlaying }

  /** Set BGM volume (0–1). Also applies to currently playing BGM. */
  setVolume(v: number) {
    this._volume = v
    if (this.bgmAudio) this.bgmAudio.volume = v
  }

  update(delta: number) {
    if (this.mixer) this.mixer.update(delta)
    if (this._ikActive) this.ikHandler.update()
  }

  // ── CrossFade helper ─────────────────────────────────────────────────────

  private crossFadeTo(newAction: THREE.AnimationAction, duration = 0.3) {
    newAction.reset().setEffectiveWeight(1).play()
    const prev = this.currentAction ?? this.idleAction
    if (prev && prev !== newAction) {
      prev.crossFadeTo(newAction, duration, false)
    }
    this.currentAction = newAction
  }

  // ── Load & play idle animation ───────────────────────────────────────────

  async loadIdle(path: string) {
    const clip = await this.loadVRMA(path)
    if (!clip) return
    reAnchorRootPositionTrack(clip, this.vrm)
    this.idleClip = clip
    this.startIdle()
  }

  /** (Re)start idle via crossFade. */
  private startIdle() {
    if (!this.idleClip) return
    this.idleAction = this.mixer.clipAction(this.idleClip)
    this.crossFadeTo(this.idleAction)
  }

  // ── Clear current action (private) ──────────────────────────────────────

  private clearTimers() {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null }
    if (this._actionSafetyTimer) { clearTimeout(this._actionSafetyTimer); this._actionSafetyTimer = null }
  }

  // ── Reset to idle (public) ──────────────────────────────────────────────
  // Full reset: stop BGM + stop dance + restart idle on a fresh mixer.

  resetToIdle() {
    this.stopBgm()
    this.clearTimers()
    this.disableIK()

    const wasDancing = this._isDancing
    this._isDancing = false
    this._actionPlaying = false
    this._actionGeneration++ // invalidate any in-flight playAction

    // CrossFade back to idle
    this.idleAction = this.mixer.clipAction(this.idleClip)
    this.crossFadeTo(this.idleAction)

    if (wasDancing) this.onDanceStop?.()
  }

  // ── Play a one-shot action ──────────────────────────────────────────────

  private _actionGeneration = 0

  async playAction(name: string, hold = false) {
    console.log('[Motion] playAction:', name, { isDancing: this._isDancing, actionPlaying: this._actionPlaying })
    if (this._actionPlaying) return
    if (this._isDancing) return

    const preset = actionPresets[name]
    if (!preset) { console.warn('[Motion] unknown action:', name); return }

    // Set lock BEFORE async load to prevent concurrent playAction calls
    this._actionPlaying = true
    const gen = ++this._actionGeneration

    console.log('[Motion] loading clip:', preset.type, preset.url)
    const clip = await this.loadClip(preset)

    // Check if state was reset or another action started during await
    if (gen !== this._actionGeneration) return
    if (!clip) { console.warn('[Motion] clip load failed for:', name); this._actionPlaying = false; return }
    console.log('[Motion] playing:', name)

    this.clearTimers()

    const action = this.mixer.clipAction(clip)
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true  // always clamp to avoid T-pose on finish
    this.crossFadeTo(action)

    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      this.mixer.removeEventListener('finished', onFinished)
      // Stale settle: another action or resetToIdle already took over
      if (gen !== this._actionGeneration) return
      this.clearTimers()
      if (hold) {
        this.holdTimer = setTimeout(() => {
          if (gen !== this._actionGeneration) return
          this._actionPlaying = false
          this.disableIK()
          this.startIdle()
        }, 10000)
      } else {
        this._actionPlaying = false
        this.disableIK()
        this.startIdle()
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

      this.clearTimers()
      this._actionPlaying = false

      this.onDanceStart?.()

      // Play BGM if preset has one
      this.stopBgmImmediate()
      if (preset?.bgm) {
        this.bgmAudio = new Audio(preset.bgm)
        this.bgmAudio.loop = true
        this.bgmAudio.volume = this._volume
        this.bgmAudio.play().catch(() => {})
      }

      const danceAction = this.mixer.clipAction(clip)
      danceAction.setLoop(THREE.LoopRepeat, Infinity)
      this.crossFadeTo(danceAction)
    } catch (err) {
      console.error('Failed to start dance:', err)
      this._isDancing = false
    }
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
    this.clearTimers()
    this.disableIK()
    this._isDancing = false
    this._actionPlaying = false
    this._actionGeneration++
    if (this.mixer) {
      this.mixer.stopAllAction()
      this.mixer.uncacheRoot(this.vrm.scene)
      this.mixer = null
    }
    this.idleAction = null
    this.currentAction = null
  }

  // ── Internal ────────────────────────────────────────────────────────────

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
