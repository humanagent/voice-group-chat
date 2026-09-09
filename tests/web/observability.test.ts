import { afterEach, describe, expect, it, vi } from "vitest"
import { frameSummary, parseSamples } from "@/lib/telemetry-schema"
import { POST } from "@/app/api/telemetry/route"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe("privacy and limits of frontend telemetry", () => {
  const metric = { name: "INP", value: 87, at: 3500 }
  it("strips arbitrary fields rather than logging message content or URLs", () => {
    expect(parseSamples([{ ...metric, transcript: "private", url: "https://secret" }])).toEqual([metric])
  })
  it("rejects unrecognized events, invalid numbers and unbounded batches", () => {
    expect(parseSamples([{ ...metric, name: "private message" }])).toBeNull()
    expect(parseSamples([{ ...metric, value: Infinity }])).toBeNull()
    expect(parseSamples([{ ...metric, at: -1 }])).toBeNull()
    expect(parseSamples(Array(41).fill(metric))).toBeNull()
    expect(parseSamples([{ ...metric, id: "token?secret=value" }])).toBeNull()
  })
  it("computes frame tails without assuming a 60Hz display", () => {
    expect(frameSummary([8.3, 8.3, 8.3, 8.3])).toEqual({ p95: 8.3, stalls: 0 })
    expect(frameSummary([16, 16, 18, 72])).toEqual({ p95: 72, stalls: 1 })
    expect(frameSummary([])).toBeNull()
  })
  it("accepts same-origin numeric batches and logs only the validated shape", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    const response = await POST(new Request("http://localhost/api/telemetry", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify([{ ...metric, text: "private" }]) }))
    expect(response.status).toBe(204)
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "frontend.performance", version: 1, samples: [metric] }))
  })
  it("rejects foreign origins and limits the actual body bytes", async () => {
    const foreign = await POST(new Request("http://localhost/api/telemetry", { method: "POST", headers: { origin: "https://elsewhere.test", "content-type": "application/json" }, body: "[]" }))
    expect(foreign.status).toBe(403)
    const huge = await POST(new Request("http://localhost/api/telemetry", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(16385) }))
    expect(huge.status).toBe(413)
  })
  it("works behind a TLS-terminating hosting proxy", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    const response = await POST(new Request("http://0.0.0.0:3000/api/telemetry", {
      method: "POST", headers: { host: "room.example.com", origin: "https://room.example.com", "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify([metric]),
    }))
    expect(response.status).toBe(204)
  })
  it("keeps local logging working when an optional batch exporter throws", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("window", new EventTarget())
    vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false, documentElement: { dataset: {} } }))
    vi.stubGlobal("navigator", { onLine: true, sendBeacon: () => false })
    const send = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", send)
    const { record, startTelemetry, subscribeBatches } = await import("@/lib/telemetry")
    const remove = subscribeBatches(() => { throw new Error("Exporter unavailable") })
    startTelemetry()
    record("dictation_render", 12)
    expect(() => window.dispatchEvent(new Event("pagehide"))).not.toThrow()
    expect(send).toHaveBeenCalledWith("/api/telemetry", expect.objectContaining({ body: expect.stringContaining('"name":"dictation_render"') }))
    remove()
  })
})
