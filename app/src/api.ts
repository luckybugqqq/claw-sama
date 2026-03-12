import type { VRMSceneHandle } from './components/VRMScene'

let sceneHandle: VRMSceneHandle | null = null

export function bindScene(handle: VRMSceneHandle | null) {
  sceneHandle = handle
}

/**
 * POST to a server API. If the request body contains an `emotion` field,
 * the VRM expression will automatically change to match.
 *
 * Body example:
 *   { emotion: "happy", message: "hello", ... }
 *
 * Supported emotions: happy, sad, angry, surprised, think, neutral
 *
 * Optional fields:
 *   emotionDuration — ms, auto-reset to neutral after this time
 *   emotionIntensity — 0~1, defaults to 1
 */
export async function postApi<T = any>(url: string, body: Record<string, any>): Promise<T> {
  // Trigger emotion from the request body
  if (body.emotion && sceneHandle) {
    const duration = body.emotionDuration as number | undefined
    const intensity = body.emotionIntensity as number | undefined
    if (duration) {
      sceneHandle.setEmotionWithReset(body.emotion, duration, intensity)
    } else {
      sceneHandle.setEmotion(body.emotion, intensity)
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`)
  }

  return res.json()
}
