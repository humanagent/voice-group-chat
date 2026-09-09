"use client"

import { useEffect } from "react"

/** iOS can pan AND resize its visual viewport when focusing an input. */
export function useRoomViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    const root = document.documentElement
    root.dataset.roomViewport = "true"
    let frame = 0
    const settling = new Set<ReturnType<typeof setTimeout>>()
    const sync = () => {
      frame = 0
      // Leave pinch zoom in the browser's hands.
      if (viewport && viewport.scale !== 1) return
      const focused = document.activeElement
      const editing = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement ||
        (focused instanceof HTMLElement && focused.isContentEditable)
      const height = viewport?.height ?? window.innerHeight
      const keyboard = editing && window.innerHeight - height > 120
      // Outside keyboard mode, CSS dvh fills the standalone app, including its
      // safe areas. Some iOS versions report a shorter visualViewport even after
      // dismissal; persisting that number leaves a blank strip below the room.
      root.style.setProperty("--room-viewport-height", keyboard ? `${height}px` : "100dvh")
      root.style.setProperty("--room-viewport-top", keyboard ? `${Math.max(0, viewport?.offsetTop ?? 0)}px` : "0px")
      root.dataset.keyboard = String(keyboard)
      root.dataset.compact = String(height < 620)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync) }
    const settle = () => {
      schedule()
      // iOS focus/blur and rotation can precede the final keyboard geometry.
      for (const timer of settling) clearTimeout(timer)
      settling.clear()
      for (const delay of [100, 350]) {
        const timer = setTimeout(() => { settling.delete(timer); schedule() }, delay)
        settling.add(timer)
      }
    }
    sync()
    viewport?.addEventListener("resize", schedule)
    viewport?.addEventListener("scroll", schedule)
    window.addEventListener("resize", settle)
    window.addEventListener("orientationchange", settle)
    window.addEventListener("pageshow", settle)
    document.addEventListener("focusin", settle)
    document.addEventListener("focusout", settle)
    document.addEventListener("visibilitychange", settle)
    // Keep the opt-in diagnostics shortcut above even a multiline recorder.
    const composer = document.querySelector(".composer-wrap")
    const observer = new ResizeObserver(([entry]) => {
      if (entry) root.style.setProperty("--room-composer-height", `${entry.target.getBoundingClientRect().height}px`)
    })
    if (composer) observer.observe(composer)
    return () => {
      cancelAnimationFrame(frame)
      for (const timer of settling) clearTimeout(timer)
      viewport?.removeEventListener("resize", schedule)
      viewport?.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", settle)
      window.removeEventListener("orientationchange", settle)
      window.removeEventListener("pageshow", settle)
      document.removeEventListener("focusin", settle)
      document.removeEventListener("focusout", settle)
      document.removeEventListener("visibilitychange", settle)
      observer.disconnect()
      root.style.removeProperty("--room-composer-height")
      root.style.removeProperty("--room-viewport-height")
      root.style.removeProperty("--room-viewport-top")
      delete root.dataset.compact
      delete root.dataset.keyboard
      delete root.dataset.roomViewport
    }
  }, [])
}
