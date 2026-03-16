import type { VRM } from '@pixiv/three-vrm'

interface EmotionExpr {
  name: string
  value: number
}

interface EmotionState {
  expression: EmotionExpr[]
  blendDuration: number
}

const emotionStates = new Map<string, EmotionState>([
  ['happy', {
    expression: [
      { name: 'happy', value: 0.7 },
      { name: 'aa', value: 0.2 },
    ],
    blendDuration: 0.4,
  }],
  ['sad', {
    expression: [
      { name: 'sad', value: 0.7 },
      { name: 'oh', value: 0.15 },
    ],
    blendDuration: 0.4,
  }],
  ['angry', {
    expression: [
      { name: 'angry', value: 0.7 },
      { name: 'ee', value: 0.3 },
    ],
    blendDuration: 0.3,
  }],
  ['surprised', {
    expression: [
      { name: 'surprised', value: 0.8 },
      { name: 'oh', value: 0.4 },
    ],
    blendDuration: 0.15,
  }],
  ['think', {
    expression: [
      { name: 'think', value: 0.7 },
    ],
    blendDuration: 0.5,
  }],
  ['awkward', {
    expression: [
      { name: 'sad', value: 0.3 },
      { name: 'ee', value: 0.2 },
    ],
    blendDuration: 0.5,
  }],
  ['question', {
    expression: [
      { name: 'surprised', value: 0.4 },
      { name: 'think', value: 0.3 },
    ],
    blendDuration: 0.4,
  }],
  ['curious', {
    expression: [
      { name: 'think', value: 0.5 },
      { name: 'surprised', value: 0.2 },
    ],
    blendDuration: 0.4,
  }],
  ['neutral', {
    expression: [
      { name: 'neutral', value: 1.0 },
    ],
    blendDuration: 0.6,
  }],
  ['love', {
    expression: [
      { name: 'happy', value: 0.6 },
      { name: 'relaxed', value: 0.4 },
    ],
    blendDuration: 0.4,
  }],
  ['flirty', {
    expression: [
      { name: 'happy', value: 0.5 },
      { name: 'relaxed', value: 0.3 },
      { name: 'aa', value: 0.15 },
    ],
    blendDuration: 0.4,
  }],
  ['greeting', {
    expression: [
      { name: 'happy', value: 0.6 },
      { name: 'aa', value: 0.3 },
    ],
    blendDuration: 0.3,
  }],
  ['relaxed', {
    expression: [
      { name: 'relaxed', value: 0.8 },
    ],
    blendDuration: 0.5,
  }],
])

export class EmoteController {
  private vrm: VRM
  private currentEmotion: string | null = null
  private isTransitioning = false
  private transitionProgress = 0
  private currentValues = new Map<string, number>()
  private targetValues = new Map<string, number>()
  private resetTimer: ReturnType<typeof setTimeout> | null = null

  constructor(vrm: VRM) {
    this.vrm = vrm
  }

  setEmotion(emotionName: string, intensity = 1) {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer)
      this.resetTimer = null
    }

    const state = emotionStates.get(emotionName)
    if (!state) {
      console.warn(`Emotion "${emotionName}" not found`)
      return
    }

    this.currentEmotion = emotionName
    this.isTransitioning = true
    this.transitionProgress = 0
    this.currentValues.clear()
    this.targetValues.clear()

    const clampedIntensity = Math.min(1, Math.max(0, intensity))

    // Capture current expression values as start point
    if (this.vrm.expressionManager) {
      const names = Object.keys(this.vrm.expressionManager.expressionMap)
      for (const name of names) {
        this.currentValues.set(name, this.vrm.expressionManager.getValue(name) || 0)
        this.targetValues.set(name, 0)
      }
    }

    // Set targets for this emotion
    for (const expr of state.expression) {
      this.targetValues.set(expr.name, expr.value * clampedIntensity)
    }
  }

  setEmotionWithReset(emotionName: string, durationMs: number, intensity = 1) {
    this.setEmotion(emotionName, intensity)
    this.resetTimer = setTimeout(() => {
      this.setEmotion('neutral')
      this.resetTimer = null
    }, durationMs)
  }

  update(deltaTime: number) {
    if (!this.isTransitioning || !this.currentEmotion) return

    const state = emotionStates.get(this.currentEmotion)!
    this.transitionProgress += deltaTime / state.blendDuration

    if (this.transitionProgress >= 1) {
      this.transitionProgress = 1
      this.isTransitioning = false
    }

    const t = this.transitionProgress
    const ease = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2

    for (const [name, target] of this.targetValues) {
      const start = this.currentValues.get(name) || 0
      const value = start + (target - start) * ease
      this.vrm.expressionManager?.setValue(name, value)
    }
  }

  dispose() {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer)
      this.resetTimer = null
    }
  }
}
