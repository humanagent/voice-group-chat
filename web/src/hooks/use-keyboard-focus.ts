"use client"

import { useRef, type TouchEvent } from "react"

/** Keep the first tap from invoking Safari's native input-centering scroll.
 * Focus stays in the user gesture so iOS still opens its software keyboard.
 * Subsequent taps, selection, scrolling and pinch zoom remain native.
 */
export function useKeyboardFocus<T extends HTMLInputElement | HTMLTextAreaElement>() {
  const start = useRef<{ x: number; y: number; id: number } | null>(null)
  return {
    onTouchStart(event: TouchEvent<T>) {
      const touch = event.touches[0]
      start.current = event.touches.length === 1 && document.activeElement !== event.currentTarget
        ? { x: touch.clientX, y: touch.clientY, id: touch.identifier } : null
    },
    onTouchMove(event: TouchEvent<T>) {
      const touch = event.touches[0]
      if (!touch || event.touches.length !== 1 || (start.current && Math.hypot(touch.clientX - start.current.x, touch.clientY - start.current.y) > 8)) start.current = null
    },
    onTouchCancel() { start.current = null },
    onTouchEnd(event: TouchEvent<T>) {
      const initial = start.current
      start.current = null
      if (!initial || !event.cancelable || (window.visualViewport?.scale ?? 1) !== 1) return
      const touch = Array.from(event.changedTouches).find((touch) => touch.identifier === initial.id)
      if (!touch || Math.hypot(touch.clientX - initial.x, touch.clientY - initial.y) > 8) return
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
    },
  }
}
