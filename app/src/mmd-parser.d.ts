declare module 'mmd-parser' {
  export const CharsetEncoder: any

  export class Parser {
    parseVmd(buffer: ArrayBufferLike, leftToRight?: boolean): VmdFile
  }

  export interface VmdFile {
    metadata: {
      magic: string
      name: string
      motionCount: number
      morphCount: number
      cameraCount: number
      coordinateSystem: string
    }
    motions: {
      boneName: string
      frameNum: number
      position: number[]
      rotation: number[]
      interpolation: number[]
    }[]
    morphs: {
      morphName: string
      frameNum: number
      weight: number
    }[]
    cameras: {
      frameNum: number
      distance: number
      position: number[]
      rotation: number[]
      interpolation: number[]
      fov: number
      perspective: number
    }[]
  }
}
