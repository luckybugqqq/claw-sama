import { Euler, MathUtils, Vector3 } from 'three'

const PI2 = Math.PI * 2

export function clampByRadian(
  v: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
) {
  const hasMin = Number.isFinite(min)
  const hasMax = Number.isFinite(max)
  if (hasMin && hasMax && min === max) return min

  const newMin = hasMin ? MathUtils.euclideanModulo(min, PI2) : min
  let newMax = hasMax ? MathUtils.euclideanModulo(max, PI2) : max
  let newV = MathUtils.euclideanModulo(v, PI2)

  if (hasMin && hasMax && newMin >= newMax) {
    newMax += PI2
    if (newV < Math.PI) newV += PI2
  }
  if (hasMax && newV > newMax) newV = newMax
  else if (hasMin && newV < newMin) newV = newMin
  return MathUtils.euclideanModulo(newV, PI2)
}

export function clampVector3ByRadian(v: Vector3 | Euler, min?: Vector3, max?: Vector3) {
  return v.set(
    clampByRadian(v.x, min?.x, max?.x),
    clampByRadian(v.y, min?.y, max?.y),
    clampByRadian(v.z, min?.z, max?.z),
  )
}
