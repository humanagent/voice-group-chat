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
      root.dataset.compact = String(viewport.width <= 640 && viewport.height < 620)
    }
    sync()
    viewport.addEventListener("resize", sync)
    return () => {
      viewport.removeEventListener("resize", sync)
      root.style.removeProperty("--room-viewport-height")
      delete root.dataset.compact
    }
  }, [])
}
