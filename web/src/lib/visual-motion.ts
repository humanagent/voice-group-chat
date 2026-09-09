/** Presentation only: never changes playback, transcription or agent state. */
export function visualLoop(draw: (time: number, elapsed: number) => void, rest: () => void) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)")
  let frame = 0
  let previous = 0
  let disposed = false
  const enabled = () => !disposed && !document.hidden && !reduced.matches
  const tick = (time: number) => {
    frame = 0
    if (!enabled()) return
    const elapsed = Math.max(0, time - previous)
    previous = time
    draw(time, elapsed)
    if (enabled() && !frame) frame = requestAnimationFrame(tick)
  }
  const sync = () => {
    cancelAnimationFrame(frame)
    frame = 0
    previous = performance.now()
    if (enabled()) frame = requestAnimationFrame(tick)
    else rest()
  }
  document.addEventListener("visibilitychange", sync)
  reduced.addEventListener("change", sync)
  sync()
  return () => {
    disposed = true
    cancelAnimationFrame(frame)
    document.removeEventListener("visibilitychange", sync)
    reduced.removeEventListener("change", sync)
  }
}

/** Same 130ms response at any refresh rate; a stalled frame cannot cause a snap. */
export function easeLevel(current: number, target: number, elapsed: number) {
  return current + (target - current) * (1 - Math.exp(-Math.min(64, Math.max(0, elapsed)) / 130))
}
