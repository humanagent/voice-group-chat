import { beforeEach, describe, expect, it } from "vitest"
import { RateLimiter, caller, forgetLimiters, limiter } from "@/lib/rate-limit"

const generous = { perMinute: 600, burst: 600 }
beforeEach(forgetLimiters)

describe("what one caller may spend", () => {
  it("allows a burst, then refuses with a whole number of seconds to wait", () => {
    const limit = new RateLimiter({ perMinute: 60, burst: 3 }, generous)
    const now = Date.now()
    expect([1, 2, 3].map(() => limit.take("a", now).ok)).toEqual([true, true, true])
    const refused = limit.take("a", now)
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.retryAfter).toBeGreaterThanOrEqual(1)
  })

  it("refills over time rather than resetting on a schedule", () => {
    const limit = new RateLimiter({ perMinute: 60, burst: 2 }, generous)
    const now = Date.now()
    limit.take("a", now)
    limit.take("a", now)
    expect(limit.take("a", now).ok).toBe(false)
    // One per second at this rate, so a second buys exactly one more.
    expect(limit.take("a", now + 1000).ok).toBe(true)
    expect(limit.take("a", now + 1000).ok).toBe(false)
  })

  it("keeps callers apart", () => {
    const limit = new RateLimiter({ perMinute: 60, burst: 1 }, generous)
    const now = Date.now()
    expect(limit.take("a", now).ok).toBe(true)
    expect(limit.take("a", now).ok).toBe(false)
    expect(limit.take("b", now).ok).toBe(true)
  })
})

describe("what everybody together may spend", () => {
  it("holds the ceiling however many identities arrive", () => {
    const limit = new RateLimiter({ perMinute: 600, burst: 600 }, { perMinute: 60, burst: 4 })
    const now = Date.now()
    const allowed = Array.from({ length: 20 }, (_, i) => limit.take(`caller-${i}`, now).ok)
    expect(allowed.filter(Boolean)).toHaveLength(4)
  })

  it("does not charge a caller for a request the ceiling refused", () => {
    const limit = new RateLimiter({ perMinute: 60, burst: 2 }, { perMinute: 60, burst: 1 })
    const now = Date.now()
    expect(limit.take("a", now).ok).toBe(true)
    expect(limit.take("a", now).ok).toBe(false)
    // The ceiling refused the second one, so the caller keeps that permit and
    // spends it as soon as the shared budget recovers.
    expect(limit.take("a", now + 1000).ok).toBe(true)
  })
})

describe("who gets charged", () => {
  it("reads the proxy's view of the client, and falls back rather than throwing", () => {
    const of = (headers: Record<string, string>) => caller(new Request("http://localhost/", { headers }))
    expect(of({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })).toBe("203.0.113.7")
    expect(of({ "x-real-ip": "203.0.113.9" })).toBe("203.0.113.9")
    expect(of({})).toBe("unknown")
  })
})

describe("limiters by name", () => {
  it("returns the same bucket for the same name, so a limit survives a request", () => {
    expect(limiter("x", generous, generous)).toBe(limiter("x", generous, generous))
    expect(limiter("x", generous, generous)).not.toBe(limiter("y", generous, generous))
  })
})
