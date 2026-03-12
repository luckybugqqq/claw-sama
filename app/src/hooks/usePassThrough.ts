import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

interface CursorPosition {
  x: number
  y: number
  window_x: number
  window_y: number
  window_w: number
  window_h: number
}

/**
 * Enables window click-through when cursor is NOT over the rendered 3D model.
 * Uses Rust-side global cursor monitoring + render-target alpha hit-test.
 */
export function usePassThrough(enabled: boolean) {
  const passingThrough = useRef(false)
  const pending = useRef(false)
  const active = useRef(false)

  useEffect(() => {
    const win = getCurrentWindow()

    if (!enabled) {
      active.current = false
      // Force disable pass-through immediately
      if (passingThrough.current) {
        passingThrough.current = false
        win.setIgnoreCursorEvents(false).catch(() => {})
      }
      return
    }

    active.current = true
    invoke('start_cursor_monitor').catch(console.error)

    const unlisten = listen<CursorPosition>('cursor-position', async (event) => {
      if (!active.current) return
      // Skip if a previous hit-test is still in-flight
      if (pending.current) return
      const { x, y, window_x, window_y, window_w, window_h } = event.payload

      const inside =
        x >= window_x &&
        x < window_x + window_w &&
        y >= window_y &&
        y < window_y + window_h

      if (!inside) {
        if (!passingThrough.current) {
          passingThrough.current = true
          win.setIgnoreCursorEvents(true).catch(() => {})
        }
        return
      }

      const clientX = x - window_x
      const clientY = y - window_y

      // Check if cursor is over an interactive HTML element (buttons, inputs, etc.)
      const el = document.elementFromPoint(clientX, clientY)
      const overUI = el instanceof HTMLButtonElement
        || el instanceof HTMLInputElement
        || el instanceof HTMLTextAreaElement
        || !!el?.closest('button, input, textarea, [data-no-passthrough]')

      if (overUI) {
        if (passingThrough.current) {
          passingThrough.current = false
          win.setIgnoreCursorEvents(false).catch(() => {})
        }
        return
      }

      // Use render-loop hit-test for the 3D model
      const hitTest = (window as any).__clawHitTest as
        | ((x: number, y: number) => Promise<boolean>)
        | undefined
      if (!hitTest) return

      pending.current = true
      try {
        if (!active.current) return
        const overModel = await hitTest(clientX, clientY)
        if (!active.current) return
        if (overModel && passingThrough.current) {
          passingThrough.current = false
          win.setIgnoreCursorEvents(false).catch(() => {})
        } else if (!overModel && !passingThrough.current) {
          passingThrough.current = true
          win.setIgnoreCursorEvents(true).catch(() => {})
        }
      } finally {
        pending.current = false
      }
    })

    return () => {
      active.current = false
      unlisten.then((fn) => fn())
      invoke('stop_cursor_monitor').catch(() => {})
      win.setIgnoreCursorEvents(false).catch(() => {})
      passingThrough.current = false
    }
  }, [enabled])
}
