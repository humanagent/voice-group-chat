import { afterEach, describe, expect, it, vi } from "vitest"
import { easeLevel, visualLoop } from "@/lib/visual-motion"

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function environment(initiallyReduced = false) {
  const document = Object.assign(new EventTarget(), { hidden: false })
  const media = Object.assign(new EventTarget(), { matches: initiallyReduced })
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  vi.stubGlobal("document", document)
  vi.stubGlobal("matchMedia", () => media)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  vi.spyOn(performance, "now").mockReturnValue(0)
  return { document, media, frames, tick(time: number) {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(time)
  } }
}

describe("visual-only motion", () => {
  it("uses the same easing over elapsed time at 30, 60, 90 and 120Hz", () => {
    const levels = [30, 60, 90, 120].map((rate) => {
      let value = 0
      for (let frame = 0; frame < rate; frame++) value = easeLevel(value, 1, 1000 / rate)
      return value
    })
    for (const value of levels) expect(value).toBeCloseTo(levels[0], 12)
    expect(easeLevel(0, 1, 1000)).toBe(easeLevel(0, 1, 64))
    expect(easeLevel(0.5, 1, 0)).toBe(0.5)
    expect(easeLevel(0.5, 0, 16)).toBeLessThan(0.5)
  })

  it("stops immediately when reduced motion or hidden, and resumes without duplicate loops", () => {
    const env = environment()
    const draw = vi.fn(), rest = vi.fn()
    const stop = visualLoop(draw, rest)
    expect(env.frames.size).toBe(1)
    env.tick(20)
    expect(draw).toHaveBeenLastCalledWith(20, 20)
    env.media.matches = true
    env.media.dispatchEvent(new Event("change"))
    expect(env.frames.size).toBe(0)
    expect(rest).toHaveBeenCalledOnce()
    env.tick(40)
    expect(draw).toHaveBeenCalledOnce()
    env.media.matches = false
    env.media.dispatchEvent(new Event("change"))
    env.media.dispatchEvent(new Event("change"))
    expect(env.frames.size).toBe(1)
    env.document.hidden = true
    env.document.dispatchEvent(new Event("visibilitychange"))
    expect(env.frames.size).toBe(0)
    env.document.hidden = false
    env.document.dispatchEvent(new Event("visibilitychange"))
    const stale = [...env.frames.values()][0]
    stop()
    stale(60)
    env.document.dispatchEvent(new Event("visibilitychange"))
    env.media.dispatchEvent(new Event("change"))
    expect(env.frames.size).toBe(0)
    expect(draw).toHaveBeenCalledOnce()
  })

  it("starts static when reduced motion is already enabled", () => {
    const env = environment(true)
    const draw = vi.fn(), rest = vi.fn()
    const stop = visualLoop(draw, rest)
    expect(rest).toHaveBeenCalledOnce()
    expect(env.frames.size).toBe(0)
    env.media.matches = false
    env.media.dispatchEvent(new Event("change"))
    env.tick(20)
    expect(draw).toHaveBeenCalledOnce()
    stop()
  })
})
