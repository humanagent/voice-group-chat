"use client"

import { useEffect } from "react"

/** Safari's keyboard resizes the visual viewport, even when dvh stays unchanged. */
export function useRoomViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    const sync = () => {
      // Leave pinch zoom in the browser's hands.
      if (viewport.scale !== 1) return
      root.style.setProperty("--room-viewport-height", `${viewport.height}px`)
      root.dataset.compact = String(viewport.height < 620)
    }
    sync()
    viewport.addEventListener("resize", sync)
    // Keep the opt-in diagnostics shortcut above even a multiline recorder.
    const composer = document.querySelector(".composer-wrap")
    const observer = new ResizeObserver(([entry]) => {
      if (entry) root.style.setProperty("--room-composer-height", `${entry.target.getBoundingClientRect().height}px`)
    })
    if (composer) observer.observe(composer)
    return () => {
      viewport.removeEventListener("resize", sync)
      observer.disconnect()
      root.style.removeProperty("--room-composer-height")
      root.style.removeProperty("--room-viewport-height")
      delete root.dataset.compact
    }
  }, [])
}
