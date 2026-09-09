"use client"

import { useEffect } from "react"

/** iOS can pan AND resize its visual viewport when focusing an input. */
export function useRoomViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    const root = document.documentElement
    root.dataset.roomViewport = "true"
    let frame = 0
    let trackingKeyboard = false
    let sawKeyboard = false
    let dismissal: ReturnType<typeof setTimeout> | undefined
    const settling = new Set<ReturnType<typeof setTimeout>>()
    const isEditing = () => {
      const focused = document.activeElement
      return focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement ||
        (focused instanceof HTMLElement && focused.isContentEditable)
    }
    const sync = () => {
      frame = 0
      // Leave pinch zoom in the browser's hands.
      if (viewport && viewport.scale !== 1) return
      const editing = isEditing()
      const height = viewport?.height ?? window.innerHeight
      const inset = Math.max(0, window.innerHeight - height)
      if (trackingKeyboard && inset > 120) sawKeyboard = true
      if (!editing && inset < 1 && (viewport?.offsetTop ?? 0) < 1) trackingKeyboard = false
      // Follow EVERY keyboard frame, including the first few pixels and the
      // closing animation after blur. A threshold or CSS height transition here
      // makes the composer jump or trail the OS keyboard.
      root.style.setProperty("--room-viewport-height", trackingKeyboard ? `${height}px` : "100dvh")
      // Counter the browser's native focus pan, including a scroll event that
      // arrives before the keyboard resize. This keeps the header/orbs at the
      // same SCREEN position; only the transcript gives up vertical space.
      root.style.setProperty("--room-viewport-top", trackingKeyboard ? `${Math.max(0, viewport?.offsetTop ?? 0)}px` : "0px")
      root.style.setProperty("--room-keyboard-inset", trackingKeyboard ? `${inset}px` : "0px")
      root.dataset.keyboard = String(trackingKeyboard && inset > 1)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync) }
    const finishDismissal = (delay: number) => {
      clearTimeout(dismissal)
      dismissal = setTimeout(() => {
        // iOS may dismiss the keyboard without blurring the input. Only use
        // this small-inset heuristic AFTER a real keyboard has been observed
        // and resize events stop, never to gate its opening/closing frames.
        const nearlyClosed = sawKeyboard && window.innerHeight - (viewport?.height ?? window.innerHeight) < 120 && (viewport?.offsetTop ?? 0) < 1
        if (isEditing() && !nearlyClosed) return
        // Once keyboard events settle, discard iOS's occasionally stale visual
        // height. CSS dvh fills the standalone window without a bottom strip.
        trackingKeyboard = false
        sawKeyboard = false
        schedule()
      }, delay)
    }
    const geometryChanged = () => {
      if (isEditing()) trackingKeyboard = true
      schedule()
      if (trackingKeyboard) finishDismissal(180)
    }
    const focusChanged = () => {
      clearTimeout(dismissal)
      if (isEditing()) trackingKeyboard = true
      else finishDismissal(350)
      schedule()
    }
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
    trackingKeyboard = isEditing()
    sync()
    viewport?.addEventListener("resize", geometryChanged)
    viewport?.addEventListener("scroll", geometryChanged)
    window.addEventListener("resize", settle)
    window.addEventListener("orientationchange", settle)
    window.addEventListener("pageshow", settle)
    document.addEventListener("focusin", focusChanged)
    document.addEventListener("focusout", focusChanged)
    document.addEventListener("visibilitychange", settle)
    // Keep the opt-in diagnostics shortcut above even a multiline recorder.
    const observer = new ResizeObserver(([entry]) => {
      if (entry) root.style.setProperty("--room-composer-height", `${entry.target.getBoundingClientRect().height}px`)
    })
    const observeComposer = () => {
      observer.disconnect()
      const composer = document.querySelector(".composer-wrap")
      if (composer) observer.observe(composer)
    }
    observeComposer()
    const shell = document.querySelector(".room-shell")
    const children = new MutationObserver(observeComposer)
    if (shell) children.observe(shell, { childList: true })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(dismissal)
      for (const timer of settling) clearTimeout(timer)
      viewport?.removeEventListener("resize", geometryChanged)
      viewport?.removeEventListener("scroll", geometryChanged)
      window.removeEventListener("resize", settle)
      window.removeEventListener("orientationchange", settle)
      window.removeEventListener("pageshow", settle)
      document.removeEventListener("focusin", focusChanged)
      document.removeEventListener("focusout", focusChanged)
      document.removeEventListener("visibilitychange", settle)
      observer.disconnect()
      children.disconnect()
      root.style.removeProperty("--room-composer-height")
      root.style.removeProperty("--room-viewport-height")
      root.style.removeProperty("--room-viewport-top")
      root.style.removeProperty("--room-keyboard-inset")
      delete root.dataset.keyboard
      delete root.dataset.roomViewport
    }
  }, [])
}
