"use client"

import { useEffect } from "react"

/** iOS can pan AND resize its visual viewport when focusing an input. */
export function useRoomViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    const root = document.documentElement
    root.dataset.roomViewport = "true"
    const standalone = matchMedia("(display-mode: standalone)")
    const syncMode = () => { root.dataset.roomStandalone = String(standalone.matches || !!(navigator as Navigator & { standalone?: boolean }).standalone) }
    syncMode()
    standalone.addEventListener("change", syncMode)
    let frame = 0
    let trackingKeyboard = false
    let sawKeyboard = false
    let keyboardResized = false
    let restingVisualHeight = viewport?.height ?? window.innerHeight
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
      if (!trackingKeyboard) restingVisualHeight = height
      if (trackingKeyboard && height < restingVisualHeight - 1) keyboardResized = true
      if (trackingKeyboard && inset > 120) sawKeyboard = true
      if (!editing && inset < 1 && (viewport?.offsetTop ?? 0) < 1) trackingKeyboard = false
      // Follow EVERY keyboard frame, including the first few pixels and the
      // closing animation after blur. A threshold or CSS height transition here
      // makes the composer jump or trail the OS keyboard.
      // Installed Safari can report a short visual viewport before any keyboard
      // exists. Focus alone must not shrink the shell to that stale measurement.
      root.style.setProperty("--room-viewport-height", trackingKeyboard && keyboardResized ? `${height}px` : "var(--room-rest-height, 100dvh)")
      // Counter the browser's native focus pan, including a scroll event that
      // arrives before the keyboard resize. This keeps the header/orbs at the
      // same SCREEN position; only the transcript gives up vertical space.
      root.style.setProperty("--room-viewport-top", trackingKeyboard ? `${Math.max(0, viewport?.offsetTop ?? 0)}px` : "0px")
      root.style.setProperty("--room-keyboard-inset", trackingKeyboard && keyboardResized ? `${inset}px` : "0px")
      root.dataset.keyboard = String(trackingKeyboard && keyboardResized && inset > 1)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync) }
    const finishDismissal = (delay: number) => {
      clearTimeout(dismissal)
      dismissal = setTimeout(() => {
        // iOS may dismiss the keyboard without blurring the input. Only use
        // this small-inset heuristic AFTER a real keyboard has been observed
        // and resize events stop, never to gate its opening/closing frames.
        const inset = window.innerHeight - (viewport?.height ?? window.innerHeight)
        if (inset < 120) unpan()
        const panned = (viewport?.offsetTop ?? 0) >= 1
        const nearlyClosed = sawKeyboard && inset < 120 && !panned
        // Blur can arrive well before the final resize, especially on a busy
        // device. A quiet timer is not evidence that a large keyboard is gone.
        if (inset >= 120 || panned || (isEditing() && !nearlyClosed)) return
        // Once keyboard events settle, discard iOS's occasionally stale visual
        // height. The resting CSS height fills the window without a bottom strip.
        trackingKeyboard = false
        sawKeyboard = false
        keyboardResized = false
        unpan()
        schedule()
      }, delay)
    }
    // Installed Safari pans the layout viewport up to reveal a focused input
    // and does not pan it back when the keyboard closes: the fixed body has
    // nothing to scroll, so the whole app stayed shifted up with the web view's
    // own background showing beneath the composer. Put it back ourselves.
    const unpan = () => {
      if (viewport && viewport.scale !== 1) return
      if ((viewport?.offsetTop ?? 0) >= 1 || window.scrollY >= 1) window.scrollTo(0, 0)
    }
    const geometryChanged = () => {
      if (isEditing()) trackingKeyboard = true
      // Never let the page pan vertically. The shell is sized to the visual
      // viewport, so there is nothing to reveal by panning; snap back on every
      // frame iOS tries, and counter whatever offset survives this event.
      unpan()
      // A native focus pan may be painted before the next animation frame.
      // Correct its offset in this event, not a frame later (the visible bounce).
      cancelAnimationFrame(frame)
      sync()
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
      const composer = Array.from(document.querySelectorAll(".composer-wrap")).find((node) => node.getBoundingClientRect().height > 0)
      if (composer) observer.observe(composer)
    }
    observeComposer()
    const shell = document.querySelector(".room-shell")
    const children = new MutationObserver(observeComposer)
    if (shell) children.observe(shell, { childList: true, attributes: true, attributeFilter: ["data-scoreboard"] })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(dismissal)
      for (const timer of settling) clearTimeout(timer)
      viewport?.removeEventListener("resize", geometryChanged)
      viewport?.removeEventListener("scroll", geometryChanged)
      window.removeEventListener("resize", settle)
      window.removeEventListener("orientationchange", settle)
      window.removeEventListener("pageshow", settle)
      standalone.removeEventListener("change", syncMode)
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
      delete root.dataset.roomStandalone
    }
  }, [])
}
