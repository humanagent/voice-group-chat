import { frameSummary, type MetricName, type Sample } from "./telemetry-schema"

let history: Sample[] = []
let pending: Sample[] = []
let started = false
let frame = 0
let lastSample = -Infinity
const listeners = new Set<() => void>()

export function record(name: MetricName, value: number, id?: string) {
  if (typeof window === "undefined" || !Number.isFinite(value) || value < 0) return
  const sample = { name, value: Math.round(value * 1000) / 1000, at: Math.round(performance.now()), ...(id ? { id } : {}) }
  history = [...history.slice(-119), sample]
  pending = [...pending.slice(-39), sample]
  listeners.forEach((listener) => listener())
}

export const getSamples = () => history
export function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function flush() {
  if (!pending.length || !navigator.onLine) return
  const batch = pending
  pending = []
  const body = JSON.stringify(batch)
  try {
    if (navigator.sendBeacon?.("/api/telemetry", new Blob([body], { type: "application/json" }))) return
  } catch { /* Telemetry must never interrupt a conversation. */ }
  void fetch("/api/telemetry", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {})
}

/** Sample a short interaction window, at most once every ten seconds. No idle loop. */
export function sampleFrames() {
  if (frame || document.hidden || performance.now() - lastSample < 10_000) return
  lastSample = performance.now()
  const frames: number[] = []
  let previous = 0
  const tick = (now: number) => {
    if (document.hidden) { frame = 0; return }
    if (previous) frames.push(now - previous)
    previous = now
    if (now - lastSample < 2500 && frames.length < 500) {
      frame = requestAnimationFrame(tick)
    } else {
      frame = 0
      const summary = frameSummary(frames)
      if (summary) {
        record("frame_p95", summary.p95)
        record("frame_stalls", summary.stalls)
      }
    }
  }
  frame = requestAnimationFrame(tick)
}

export function startTelemetry() {
  if (started) return
  started = true
  window.addEventListener("error", () => record("runtime_error", 1))
  window.addEventListener("unhandledrejection", () => record("unhandled_rejection", 1))
  window.addEventListener("pagehide", flush)
  document.addEventListener("visibilitychange", () => {
    document.documentElement.dataset.paused = String(document.hidden)
    if (document.hidden) flush()
  })
  document.addEventListener("pointerdown", sampleFrames, { passive: true })
  document.addEventListener("keydown", sampleFrames, { passive: true })
  setInterval(flush, 15_000)
  if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record("long_task", entry.duration)
    })
    observer.observe({ type: "longtask", buffered: true })
  }
}
