import { useEffect, useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation'
import type { VRM } from '@pixiv/three-vrm'
import { EmoteController } from '../emote'
import { LipSync } from '../lip-sync'
import { MotionController } from '../motion-controller'
import { getCurrentWindow } from '@tauri-apps/api/window'

export type TouchRegion = 'head' | 'arm' | 'leg' | 'chest' | 'belly' | 'buttocks'

interface VRMSceneProps {
  modelPath: string
  idleAnimationPath?: string
  onTouch?: (region: TouchRegion) => void
  onModelLoaded?: () => void
}

export type TrackingMode = 'mouse' | 'camera'

export interface VRMSceneHandle {
  setEmotion: (emotion: string, intensity?: number) => void
  setEmotionWithReset: (emotion: string, durationMs: number, intensity?: number) => void
  resetCamera: () => void
  setTrackingMode: (mode: TrackingMode) => void
  playAction: (name: string, hold?: boolean) => void
  captureScreenshot: () => string | null
  panCamera: (dx: number, dy: number) => void
  rotateCamera: (dx: number, dy: number) => void
  playDance: (nameOrPreset: string | import('../motion-controller').DancePreset) => void
  stopDance: () => void
  isDancing: () => boolean
  setBgmVolume: (v: number) => void
  /** Unified reset: camera + resetToIdle + expressions to zero */
  reset: () => void
}

// ── Blink state ───────────────────────────────────────────────────────────────
interface BlinkState {
  isBlinking: boolean
  blinkProgress: number
  timeSinceLastBlink: number
  nextBlinkTime: number
}

function createBlinkState(): BlinkState {
  return {
    isBlinking: false,
    blinkProgress: 0,
    timeSinceLastBlink: 0,
    nextBlinkTime: Math.random() * 4 + 1,
  }
}

function updateBlink(vrm: VRM, delta: number, state: BlinkState) {
  if (!vrm.expressionManager) return

  state.timeSinceLastBlink += delta

  if (!state.isBlinking && state.timeSinceLastBlink >= state.nextBlinkTime) {
    state.isBlinking = true
    state.blinkProgress = 0
  }

  if (state.isBlinking) {
    const BLINK_DURATION = 0.15
    state.blinkProgress += delta / BLINK_DURATION
    const blinkValue = Math.sin(Math.PI * state.blinkProgress)
    vrm.expressionManager.setValue('blink', blinkValue)

    if (state.blinkProgress >= 1) {
      state.isBlinking = false
      state.timeSinceLastBlink = 0
      vrm.expressionManager.setValue('blink', 0)
      state.nextBlinkTime = Math.random() * 5 + 1
    }
  }
}

// ── Relaxed hand pose ─────────────────────────────────────────────────────────
// The idle_loop.vrma often has no finger tracks, so fingers stay in the stiff
// T-pose. This must be applied EVERY FRAME after mixer.update() because the
// AnimationMixer resets bones that have no tracks back to their rest rotation.
//
// VRM normalized bones use Z-axis for finger curl (spread is Y-axis).
// Left hand curls positive Z, right hand curls negative Z.
// We also add slight spread (Y-axis) variation per finger for a natural look,
// and subtle per-frame micro-movement to avoid a "frozen" appearance.

interface HandPoseCache {
  bones: { bone: THREE.Object3D; z: number; y: number }[]
}

function buildHandPoseCache(vrm: VRM): HandPoseCache {
  const humanoid = vrm.humanoid
  const bones: HandPoseCache['bones'] = []
  if (!humanoid) return { bones }

  const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const
  const segments = ['Proximal', 'Intermediate', 'Distal'] as const
  const sides = ['left', 'right'] as const

  // Base curl values — outer fingers curl more for a natural resting hand
  const curlMap: Record<string, [number, number, number]> = {
    Thumb:  [0.25, 0.15, 0.10],
    Index:  [0.20, 0.30, 0.20],
    Middle: [0.25, 0.35, 0.25],
    Ring:   [0.30, 0.40, 0.30],
    Little: [0.35, 0.45, 0.30],
  }

  // Slight spread (Y-axis) to fan fingers apart naturally
  const spreadMap: Record<string, number> = {
    Thumb:  0.15,
    Index:  0.04,
    Middle: 0.0,
    Ring:   -0.04,
    Little: -0.08,
  }

  for (const side of sides) {
    const sign = side === 'left' ? 1 : -1

    for (const finger of fingers) {
      const curls = curlMap[finger]
      const spread = spreadMap[finger]

      for (let s = 0; s < segments.length; s++) {
        const boneName = `${side}${finger}${segments[s]}` as any
        const bone = humanoid.getNormalizedBoneNode(boneName)
        if (!bone) continue

        const z = sign * curls[s]
        // Only apply spread on the proximal segment
        const y = s === 0 ? sign * spread : 0

        bones.push({ bone, z, y })
      }
    }
  }

  return { bones }
}

function applyRelaxedHandPose(cache: HandPoseCache, time: number) {
  for (const { bone, z, y } of cache.bones) {
    // Subtle micro-movement: ±0.02 rad oscillation at slightly different
    // frequencies per bone (seeded by the base z value) to avoid uniformity
    const freq = 0.3 + Math.abs(z) * 2
    const micro = Math.sin(time * freq + z * 50) * 0.02
    bone.rotation.z = z + micro
    if (y !== 0) bone.rotation.y = y
  }
}


export const VRMScene = forwardRef<VRMSceneHandle, VRMSceneProps>(function VRMScene({
  modelPath,
  idleAnimationPath = '/idle_loop.vrma',
  onTouch,
  onModelLoaded,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number; confirmed: boolean }[]>([])
  const rippleIdRef = useRef(0)

  const spawnRipple = useCallback((x: number, y: number, confirmed: boolean) => {
    const id = ++rippleIdRef.current
    setRipples(prev => [...prev, { id, x, y, confirmed }])
    setTimeout(() => setRipples(prev => prev.filter(r => r.id !== id)), confirmed ? 700 : 500)
  }, [])

  const emoteRef = useRef<EmoteController | null>(null)
  const resetCameraRef = useRef<(() => void) | null>(null)
  const trackingModeRef = useRef<TrackingMode>('mouse')
  const motionRef = useRef<MotionController | null>(null)
  const panCameraRef = useRef<((dx: number, dy: number) => void) | null>(null)
  const rotateCameraRef = useRef<((dx: number, dy: number) => void) | null>(null)
  const lipSyncRef = useRef<LipSync>(LipSync.getInstance())
  const onTouchRef = useRef(onTouch)
  onTouchRef.current = onTouch
  const onModelLoadedRef = useRef(onModelLoaded)
  onModelLoadedRef.current = onModelLoaded

  useImperativeHandle(ref, () => ({
    setEmotion(emotion: string, intensity?: number) {
      emoteRef.current?.setEmotion(emotion, intensity)
    },
    setEmotionWithReset(emotion: string, durationMs: number, intensity?: number) {
      emoteRef.current?.setEmotionWithReset(emotion, durationMs, intensity)
    },
    resetCamera() {
      resetCameraRef.current?.()
    },
    setTrackingMode(mode: TrackingMode) {
      trackingModeRef.current = mode
    },
    playAction(name: string, hold?: boolean) {
      motionRef.current?.playAction(name, hold)
    },
    captureScreenshot() {
      return canvasRef.current?.toDataURL('image/png') ?? null
    },
    panCamera(dx: number, dy: number) {
      panCameraRef.current?.(dx, dy)
    },
    rotateCamera(dx: number, dy: number) {
      rotateCameraRef.current?.(dx, dy)
    },
    playDance(nameOrPreset: string | import('../motion-controller').DancePreset) {
      motionRef.current?.playDance(nameOrPreset)
    },
    stopDance() {
      motionRef.current?.resetToIdle()
    },
    isDancing() {
      return motionRef.current?.isDancing ?? false
    },
    setBgmVolume(v: number) {
      motionRef.current?.setVolume(v)
    },
    reset() {
      resetCameraRef.current?.()
      motionRef.current?.resetToIdle()
      emoteRef.current?.resetAll()
    },
  }))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // ── Renderer ──────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    })
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setClearColor(0x000000, 0)

    // ── Scene ─────────────────────────────────────────────────────────────────
    const scene = new THREE.Scene()

    // ── Camera ────────────────────────────────────────────────────────────────
    const FOV = 40
    const camera = new THREE.PerspectiveCamera(
      FOV,
      window.innerWidth / window.innerHeight,
      0.1,
      100,
    )
    // Orbit state: camera orbits around the pivot point
    // Will be recalculated after model loads (like airi)
    const pivot = new THREE.Vector3(0, 0, 0)
    let orbitRadius = 2.0
    let orbitTheta = 0       // horizontal angle (radians)
    let orbitPhi = Math.PI / 2 // vertical angle (radians), PI/2 = eye level

    function updateCameraOrbit() {
      camera.position.set(
        pivot.x + orbitRadius * Math.sin(orbitPhi) * Math.sin(orbitTheta),
        pivot.y + orbitRadius * Math.cos(orbitPhi),
        pivot.z + orbitRadius * Math.sin(orbitPhi) * Math.cos(orbitTheta),
      )
      camera.lookAt(pivot)
    }
    updateCameraOrbit()

    // ── Lights ────────────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
    dirLight.position.set(1, 2, 3)
    scene.add(dirLight)
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
    fillLight.position.set(-2, 1, -1)
    scene.add(fillLight)

    // ── Loader ───────────────────────────────────────────────────────────────
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))

    // ── State ─────────────────────────────────────────────────────────────────
    let vrm: VRM | null = null
    let motion: MotionController | null = null
    let emote: EmoteController | null = null
    let handPose: HandPoseCache | null = null
    const blinkState = createBlinkState()
    const saccades = new EyeSaccadeController()
    const lookAtTarget = { x: 0, y: 0, z: -100 }

    // ── Load VRM model, then load idle animation ─────────────────────────────
    loader.load(
      modelPath,
      async (gltf) => {
        const loadedVrm = gltf.userData.vrm as VRM
        if (!loadedVrm) {
          console.error('No VRM data found in GLTF')
          return
        }

        VRMUtils.removeUnnecessaryVertices(loadedVrm.scene)
        VRMUtils.combineSkeletons(loadedVrm.scene)
        loadedVrm.scene.traverse((obj) => {
          obj.frustumCulled = false
        })

        // Add lookAt quaternion proxy (from airi — needed for lookAt to work)
        if (loadedVrm.lookAt) {
          const lookAtQuatProxy = new VRMLookAtQuaternionProxy(loadedVrm.lookAt)
          lookAtQuatProxy.name = 'lookAtQuaternionProxy'
          loadedVrm.scene.add(lookAtQuatProxy)
        }

        // Normalize VRM 0.x to match 1.0 convention, then face camera
        VRMUtils.rotateVRM0(loadedVrm)

        scene.add(loadedVrm.scene)
        vrm = loadedVrm
        console.log('VRM loaded')

        // ── Compute camera from model bounds (airi style) ───────────────────
        const box = new THREE.Box3().setFromObject(loadedVrm.scene)
        const modelSize = new THREE.Vector3()
        const modelCenter = new THREE.Vector3()
        box.getSize(modelSize)
        box.getCenter(modelCenter)
        modelCenter.y += modelSize.y / 3.2 // pivot at neck height

        const radians = (FOV / 2 * Math.PI) / 180
        const offsetX = modelSize.x / 16
        const offsetY = modelSize.y / 10
        const offsetZ = (modelSize.y / 4.2) / Math.tan(radians)

        pivot.copy(modelCenter)
        orbitRadius = offsetZ
        orbitTheta = Math.atan2(offsetX, offsetZ)
        orbitPhi = Math.PI / 2 - Math.atan2(offsetY, offsetZ)
        updateCameraOrbit()

        // Store initial state for reset
        const initPivot = pivot.clone()
        const initRadius = orbitRadius
        const initTheta = orbitTheta
        const initPhi = orbitPhi
        resetCameraRef.current = () => {
          pivot.copy(initPivot)
          orbitRadius = initRadius
          orbitTheta = initTheta
          orbitPhi = initPhi
          updateCameraOrbit()
        }

        panCameraRef.current = (dx: number, dy: number) => {
          const right = new THREE.Vector3()
          const up = new THREE.Vector3()
          camera.getWorldDirection(new THREE.Vector3())
          right.setFromMatrixColumn(camera.matrixWorld, 0) // camera right
          up.setFromMatrixColumn(camera.matrixWorld, 1)    // camera up
          pivot.addScaledVector(right, -dx * 0.003)
          pivot.addScaledVector(up, dy * 0.003)
          updateCameraOrbit()
        }

        rotateCameraRef.current = (dx: number, dy: number) => {
          orbitTheta -= dx * 0.005
          orbitPhi = THREE.MathUtils.clamp(
            orbitPhi - dy * 0.005,
            0.1,
            Math.PI - 0.1,
          )
          updateCameraOrbit()
        }

        // Build hand pose cache (applied every frame in animate loop)
        handPose = buildHandPoseCache(loadedVrm)

        // Initialize emote controller
        emote = new EmoteController(loadedVrm)
        emoteRef.current = emote

        // ── Initialize MotionController ──────────────────────────────────────
        motion = new MotionController(loadedVrm)
        motionRef.current = motion

        // Dance camera: auto-fit from hips position, centered on upper body
        const danceRadius = (modelSize.y / 1.6) / Math.tan((FOV / 2 * Math.PI) / 180)

        motion.onDanceStart = () => {
          const hipsNode = loadedVrm.humanoid?.getNormalizedBoneNode('hips')
          if (hipsNode) {
            const hipsWorld = new THREE.Vector3()
            hipsNode.getWorldPosition(hipsWorld)
            // Pivot at hips height (upper body center)
            pivot.set(hipsWorld.x, hipsWorld.y, hipsWorld.z)
          } else {
            pivot.copy(modelCenter)
          }
          orbitRadius = danceRadius
          orbitTheta = 0
          orbitPhi = Math.PI / 2
          updateCameraOrbit()
        }
        motion.onDanceStop = () => {
          pivot.copy(initPivot)
          orbitRadius = initRadius
          orbitTheta = initTheta
          orbitPhi = initPhi
          updateCameraOrbit()
        }

        // Load idle animation (non-blocking for fast startup)
        motion.loadIdle(idleAnimationPath).catch((err) =>
          console.warn('Failed to load idle animation:', err),
        )

        // Reset spring bones after everything is set up
        loadedVrm.springBoneManager?.reset()

        // Notify parent that model is ready (for auto-screenshot etc.)
        // Delay slightly so the first frame is rendered
        setTimeout(() => onModelLoadedRef.current?.(), 500)
      },
      (progress) => {
        const pct = ((progress.loaded / (progress.total || 1)) * 100).toFixed(1)
        console.log(`Loading VRM: ${pct}%`)
      },
      (err) => {
        console.error('Failed to load VRM:', err)
      },
    )

    // ── Mouse tracking ────────────────────────────────────────────────────────
    const mouse = new THREE.Vector2(0, 0)

    const _raycaster = new THREE.Raycaster()
    const _mouseVec = new THREE.Vector2()

    function onMouseMove(e: MouseEvent) {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1

      if (trackingModeRef.current !== 'mouse') return

      // Compute lookAt target like airi's lookAtMouse
      _mouseVec.set(mouse.x, mouse.y)
      _raycaster.setFromCamera(_mouseVec, camera)
      const camDir = new THREE.Vector3()
      camera.getWorldDirection(camDir)
      const plane = new THREE.Plane()
      plane.setFromNormalAndCoplanarPoint(
        camDir,
        camera.position.clone().add(camDir.multiplyScalar(1)),
      )
      const intersection = new THREE.Vector3()
      if (_raycaster.ray.intersectPlane(plane, intersection)) {
        lookAtTarget.x = intersection.x
        lookAtTarget.y = intersection.y
        lookAtTarget.z = intersection.z
        if (vrm) {
          saccades.instantUpdate(vrm, lookAtTarget)
        }
      }
    }
    // Listen on both window and document to handle transparent window cases
    window.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mousemove', onMouseMove)

    // ── Scroll zoom ──────────────────────────────────────────────────────────
    const MIN_RADIUS = 0.8
    const MAX_RADIUS = 5.0
    const ZOOM_SPEED = 0.002

    function onWheel(e: WheelEvent) {
      e.preventDefault()
      orbitRadius = THREE.MathUtils.clamp(
        orbitRadius + e.deltaY * ZOOM_SPEED,
        MIN_RADIUS,
        MAX_RADIUS,
      )
      updateCameraOrbit()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })

    // ── Drag controls ──────────────────────────────────────────────────────
    // Left drag: move window (startDragging)
    // Middle drag: dolly (zoom)
    // Right drag: rotate around model
    let dragMode: 'rotate' | 'dolly' | 'pan' | null = null
    let prevX = 0
    let prevY = 0
    const ROTATE_SPEED = 0.005
    const PAN_SPEED = 0.003
    const DOLLY_SPEED = 0.01

    // ── Touch interaction: detect body region from raycast hit ────────────
    const touchRaycaster = new THREE.Raycaster()
    const touchMouseVec = new THREE.Vector2()
    let lastTapTime = 0
    let lastTapRegion: TouchRegion | null = null
    let lastTouchFireTime = 0
    const DOUBLE_TAP_WINDOW = 500 // ms
    const TOUCH_COOLDOWN = 5_000 // ms

    // Bone-to-region mapping for proximity-based touch detection
    const boneRegionMap: [string, TouchRegion][] = [
      // Head
      ['head', 'head'], ['neck', 'head'],
      ['leftEye', 'head'], ['rightEye', 'head'], ['jaw', 'head'],
      // Arms
      ['leftShoulder', 'arm'], ['leftUpperArm', 'arm'], ['leftLowerArm', 'arm'], ['leftHand', 'arm'],
      ['rightShoulder', 'arm'], ['rightUpperArm', 'arm'], ['rightLowerArm', 'arm'], ['rightHand', 'arm'],
      // Legs
      ['leftUpperLeg', 'leg'], ['leftLowerLeg', 'leg'], ['leftFoot', 'leg'], ['leftToes', 'leg'],
      ['rightUpperLeg', 'leg'], ['rightLowerLeg', 'leg'], ['rightFoot', 'leg'], ['rightToes', 'leg'],
      // Torso
      ['chest', 'chest'], ['upperChest', 'chest'],
      ['spine', 'belly'],
      ['hips', 'buttocks'],
    ]
    const _bonePos = new THREE.Vector3()

    function detectTouchRegion(e: PointerEvent): TouchRegion | null {
      if (!vrm?.humanoid) return null

      touchMouseVec.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1,
      )
      touchRaycaster.setFromCamera(touchMouseVec, camera)

      const intersects = touchRaycaster.intersectObject(vrm.scene, true)
      if (intersects.length === 0) return null

      const hitPoint = intersects[0].point

      // Find closest bone to hit point
      let closestRegion: TouchRegion = 'belly'
      let closestDist = Infinity

      for (const [boneName, region] of boneRegionMap) {
        const bone = vrm.humanoid.getNormalizedBoneNode(boneName as any)
        if (!bone) continue
        bone.getWorldPosition(_bonePos)
        const dist = hitPoint.distanceToSquared(_bonePos)
        if (dist < closestDist) {
          closestDist = dist
          closestRegion = region
        }
      }

      return closestRegion
    }

    // ── Left-click: distinguish click (touch) vs drag (move window) ────
    let leftDownPos: { x: number; y: number; time: number; region: TouchRegion | null } | null = null
    const CLICK_MOVE_THRESHOLD = 5  // px
    const CLICK_TIME_THRESHOLD = 300 // ms

    function onPointerDown(e: PointerEvent) {
      if (e.button === 0) {
        const region = detectTouchRegion(e)
        if (region) {
          // Might be a touch — wait for pointerup to confirm it's not a drag
          leftDownPos = { x: e.clientX, y: e.clientY, time: Date.now(), region }
          return
        }
        // Not on model — move window immediately
        getCurrentWindow().startDragging()
        return
      } else if (e.button === 1) {
        dragMode = 'dolly'
        e.preventDefault()
      } else if (e.button === 2) {
        dragMode = 'rotate'
      } else {
        return
      }
      prevX = e.clientX
      prevY = e.clientY
      canvas!.setPointerCapture(e.pointerId)
    }

    function onPointerMove(e: PointerEvent) {
      // If left button held on model and moved beyond threshold → it's a drag, not a touch
      if (leftDownPos && e.buttons & 1) {
        const dx = Math.abs(e.clientX - leftDownPos.x)
        const dy = Math.abs(e.clientY - leftDownPos.y)
        if (dx > CLICK_MOVE_THRESHOLD || dy > CLICK_MOVE_THRESHOLD) {
          leftDownPos = null
          getCurrentWindow().startDragging()
          return
        }
      }
      if (!dragMode) return
      const dx = e.clientX - prevX
      const dy = e.clientY - prevY
      prevX = e.clientX
      prevY = e.clientY

      if (dragMode === 'rotate') {
        orbitTheta -= dx * ROTATE_SPEED
        orbitPhi = THREE.MathUtils.clamp(
          orbitPhi - dy * ROTATE_SPEED,
          0.1,
          Math.PI - 0.1,
        )
      } else if (dragMode === 'dolly') {
        orbitRadius = THREE.MathUtils.clamp(
          orbitRadius + dy * DOLLY_SPEED,
          MIN_RADIUS,
          MAX_RADIUS,
        )
      } else if (dragMode === 'pan') {
        pivot.x -= dx * PAN_SPEED
        pivot.y += dy * PAN_SPEED
      }
      updateCameraOrbit()
    }

    function onPointerUp(e: PointerEvent) {
      // Confirm touch: short press with no movement on model
      if (leftDownPos && e.button === 0) {
        const elapsed = Date.now() - leftDownPos.time
        const dx = Math.abs(e.clientX - leftDownPos.x)
        const dy = Math.abs(e.clientY - leftDownPos.y)
        if (elapsed < CLICK_TIME_THRESHOLD && dx <= CLICK_MOVE_THRESHOLD && dy <= CLICK_MOVE_THRESHOLD) {
          const now = Date.now()
          const region = leftDownPos.region!
          if (now - lastTapTime < DOUBLE_TAP_WINDOW && lastTapRegion === region && now - lastTouchFireTime > TOUCH_COOLDOWN) {
            // Double-tap confirmed
            lastTouchFireTime = now
            spawnRipple(e.clientX, e.clientY, true)
            onTouchRef.current?.(region)
            lastTapTime = 0
            lastTapRegion = null
          } else {
            // First tap — wait for second
            spawnRipple(e.clientX, e.clientY, false)
            lastTapTime = now
            lastTapRegion = region
          }
        }
        leftDownPos = null
        return
      }
      if (dragMode) {
        dragMode = null
        canvas!.releasePointerCapture(e.pointerId)
      }
    }

    function onContextMenu(e: Event) {
      e.preventDefault()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('contextmenu', onContextMenu)

    // ── Resize ────────────────────────────────────────────────────────────────
    function onResize() {
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
      renderer.setSize(window.innerWidth, window.innerHeight)
    }
    window.addEventListener('resize', onResize)

    // ── Hit-test for window pass-through ──────────────────────────────────────
    // Offscreen render target: render scene, read 1 pixel alpha at cursor.
    // Updated in the render loop — no extra render pass, just piggybacks.
    const hitTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false })
    let pendingHitTest: { x: number; y: number; resolve: (hit: boolean) => void } | null = null
    const hitPixel = new Uint8Array(4)

    // Async hit-test: queues a request, resolved after next frame render
    ;(window as any).__clawHitTest = (clientX: number, clientY: number): Promise<boolean> => {
      return new Promise((resolve) => {
        pendingHitTest = { x: clientX, y: clientY, resolve }
      })
    }

    // ── Animation loop ────────────────────────────────────────────────────────
    const clock = new THREE.Clock()
    let animFrameId: number

    function animate() {
      animFrameId = requestAnimationFrame(animate)
      const delta = clock.getDelta()

      if (vrm) {
        // 1. Animation mixer
        motion?.update(delta)

        // 1.5. Relaxed hand pose — skip during dance (VMD has own hand anim)
        if (handPose && !motion?.isDancing) applyRelaxedHandPose(handPose, clock.elapsedTime)

        // 2. Humanoid update
        vrm.humanoid?.update()

        // 3. Camera tracking mode: look at camera position
        if (trackingModeRef.current === 'camera') {
          lookAtTarget.x = camera.position.x
          lookAtTarget.y = camera.position.y
          lookAtTarget.z = camera.position.z
          saccades.instantUpdate(vrm, lookAtTarget)
        }

        // 4. LookAt update
        vrm.lookAt?.update(delta)

        // 5. Eye saccades (airi style)
        saccades.update(vrm, lookAtTarget, delta)

        // 5. Blinking
        updateBlink(vrm, delta, blinkState)

        // 6. Emote transitions
        emote?.update(delta)

        // 7. Lip sync
        lipSyncRef.current.update(vrm, delta)

        // 8. Expression manager (apply blink etc.)
        vrm.expressionManager?.update()

        // 8. Spring bone physics
        vrm.springBoneManager?.update(delta)
      }

      renderer.render(scene, camera)

      // Process pending hit-test after render
      if (pendingHitTest && canvas) {
        const { x, y, resolve } = pendingHitTest
        pendingHitTest = null

        if (!vrm) {
          resolve(true) // Model not loaded — don't pass through
        } else {

        const dpr = renderer.getPixelRatio()
        const bufW = canvas.clientWidth * dpr
        const bufH = canvas.clientHeight * dpr

        if (hitTarget.width !== bufW || hitTarget.height !== bufH) {
          hitTarget.setSize(bufW, bufH)
        }

        // Render to offscreen target
        renderer.setRenderTarget(hitTarget)
        renderer.clear()
        renderer.render(scene, camera)
        // Read 1 pixel at cursor position
        const px = Math.floor(x * dpr)
        const py = Math.floor(bufH - y * dpr) // GL Y-flip
        renderer.readRenderTargetPixels(hitTarget, px, py, 1, 1, hitPixel)
        renderer.setRenderTarget(null)

        resolve(hitPixel[3] > 10)
        } // end else (vrm exists)
      }
    }

    animate()

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(animFrameId)
      window.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('resize', onResize)
      emote?.dispose()
      emoteRef.current = null
      motion?.dispose()
      motionRef.current = null
      hitTarget.dispose()
      delete (window as any).__clawHitTest
      renderer.dispose()
    }
  }, [modelPath, idleAnimationPath])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          background: 'transparent',
          cursor: 'grab',
        }}
      />
      {ripples.map(r => (
        <span
          key={r.id}
          className={r.confirmed ? 'touch-ripple confirmed' : 'touch-ripple'}
          style={{ left: r.x, top: r.y }}
        />
      ))}
    </div>
  )
})

// ── Eye saccade interval (from airi) ─────────────────────────────────────────
const EYE_SACCADE_INT_STEP = 400
const EYE_SACCADE_INT_P: number[][] = [
  [0.075, 800], [0.110, 0], [0.125, 0], [0.140, 0], [0.125, 0],
  [0.050, 0],   [0.040, 0], [0.030, 0], [0.020, 0], [1.000, 0],
]
for (let i = 1; i < EYE_SACCADE_INT_P.length; i++) {
  EYE_SACCADE_INT_P[i][0] += EYE_SACCADE_INT_P[i - 1][0]
  EYE_SACCADE_INT_P[i][1] = EYE_SACCADE_INT_P[i - 1][1] + EYE_SACCADE_INT_STEP
}

function randomSaccadeInterval(): number {
  const r = Math.random()
  for (let i = 0; i < EYE_SACCADE_INT_P.length; i++) {
    if (r <= EYE_SACCADE_INT_P[i][0]) {
      return EYE_SACCADE_INT_P[i][1] + Math.random() * EYE_SACCADE_INT_STEP
    }
  }
  return EYE_SACCADE_INT_P[EYE_SACCADE_INT_P.length - 1][1] + Math.random() * EYE_SACCADE_INT_STEP
}

// ── Eye saccade controller (from airi) ───────────────────────────────────────
class EyeSaccadeController {
  private nextSaccadeAfter = -1
  private timeSinceLastSaccade = 0
  private fixationTarget = new THREE.Vector3()

  /** Called when lookAt target changes (e.g. mouse moved) */
  instantUpdate(vrm: VRM, target: { x: number; y: number; z: number }) {
    this.fixationTarget.set(target.x, target.y, target.z)
    if (!vrm.lookAt) return
    if (!vrm.lookAt.target) {
      vrm.lookAt.target = new THREE.Object3D()
    }
    vrm.lookAt.target.position.copy(this.fixationTarget)
    vrm.lookAt.update(0.016)
  }

  /** Called every frame */
  update(vrm: VRM, lookAtTarget: { x: number; y: number; z: number }, delta: number) {
    if (!vrm.expressionManager || !vrm.lookAt) return

    if (this.timeSinceLastSaccade >= this.nextSaccadeAfter) {
      // Add random offset to the current lookAt target
      this.fixationTarget.set(
        lookAtTarget.x + THREE.MathUtils.randFloat(-0.25, 0.25),
        lookAtTarget.y + THREE.MathUtils.randFloat(-0.25, 0.25),
        lookAtTarget.z,
      )
      this.timeSinceLastSaccade = 0
      this.nextSaccadeAfter = randomSaccadeInterval() / 1000
    }

    if (!vrm.lookAt.target) {
      vrm.lookAt.target = new THREE.Object3D()
    }
    vrm.lookAt.target.position.lerp(this.fixationTarget, 1)
    vrm.lookAt.update(delta)

    this.timeSinceLastSaccade += delta
  }
}
