import { getCurrentWindow } from '@tauri-apps/api/window'

type ResizeDir = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West'

const EDGE = 5
const CORNER = 10

const directions: { dir: ResizeDir; style: React.CSSProperties }[] = [
  { dir: 'North', style: { top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'n-resize' } },
  { dir: 'South', style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 's-resize' } },
  { dir: 'East', style: { top: CORNER, bottom: CORNER, right: 0, width: EDGE, cursor: 'e-resize' } },
  { dir: 'West', style: { top: CORNER, bottom: CORNER, left: 0, width: EDGE, cursor: 'w-resize' } },
  { dir: 'NorthWest', style: { top: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nw-resize' } },
  { dir: 'NorthEast', style: { top: 0, right: 0, width: CORNER, height: CORNER, cursor: 'ne-resize' } },
  { dir: 'SouthWest', style: { bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: 'sw-resize' } },
  { dir: 'SouthEast', style: { bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: 'se-resize' } },
]

export function ResizeHandles() {
  return (
    <div style={containerStyle}>
      {directions.map(({ dir, style }) => (
        <div
          key={dir}
          data-no-passthrough
          style={{ ...handleStyle, ...style }}
          onMouseDown={() => getCurrentWindow().startResizeDragging(dir as any)}
        />
      ))}
    </div>
  )
}

const containerStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  pointerEvents: 'none',
  zIndex: 9999,
}

const handleStyle: React.CSSProperties = {
  position: 'absolute',
  pointerEvents: 'auto',
}
