import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "@/app/api/scribe/route"
import { key } from "@/lib/elevenlabs"
import { forgetLimiters } from "@/lib/rate-limit"

vi.mock("@/lib/elevenlabs", () => ({ key: vi.fn(() => "test-only-key") }))
// Buckets outlive a request by design, so each test starts from a full one.
beforeEach(forgetLimiters)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const requestId = "09f21ee4-fd37-4b3c-b8ee-1d3c7ba076d7"
const request = () => new Request("http://localhost/api/scribe", { method: "POST", headers: { "x-request-id": requestId } })

describe("single-use transcription token diagnostics", () => {
  it("correlates the request, disables caching and never logs the token or API key", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ token: "secret-token" })))
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-request-id")).toBe(requestId)
    expect(await response.json()).toEqual({ token: "secret-token" })
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: "speech.token", requestId, outcome: "ready", upstreamStatus: 200 })
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret-token|test-only-key/)
  })

  it("reports provider failures using status codes, not raw provider details", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async () => new Response("sensitive-provider-body", { status: 429 })))
    const response = await POST(request())
    expect(response.status).toBe(502)
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ outcome: "provider_error", upstreamStatus: 429 })
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive-provider-body")
    expect(await response.text()).not.toContain("sensitive-provider-body")
  })

  it("does not claim success for missing configuration or an empty token", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    const fetch = vi.fn(async () => Response.json({ token: "" }))
    vi.stubGlobal("fetch", fetch)
    vi.mocked(key).mockReturnValueOnce("")
    expect((await POST(request())).status).toBe(503)
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.parse(log.mock.calls[0][0]).outcome).toBe("not_configured")
    expect((await POST(request())).status).toBe(502)
    expect(JSON.parse(log.mock.calls[1][0]).outcome).toBe("invalid_response")
  })

  it("sanitizes network failures and ignores arbitrary correlation text", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("sensitive-network-detail") }))
    const response = await POST(new Request("http://localhost/api/scribe", { method: "POST", headers: { "x-request-id": "private-message" } }))
    expect(response.status).toBe(502)
    expect(JSON.parse(log.mock.calls[0][0]).outcome).toBe("network_error")
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-message|sensitive-network-detail/)
  })
})

describe("a token is worth something, so it is rationed", () => {
  it("refuses a page that is not this one, before reaching ElevenLabs", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    const fetch = vi.fn(async () => Response.json({ token: "secret-token" }))
    vi.stubGlobal("fetch", fetch)
    const response = await POST(new Request("http://localhost/api/scribe", {
      method: "POST", headers: { origin: "https://somewhere.example", host: "localhost" },
    }))
    expect(response.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.parse(log.mock.calls[0][0]).outcome).toBe("cross_origin")
  })

  it("stops one caller minting sessions in a loop, and says how long to wait", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    const fetch = vi.fn(async () => Response.json({ token: "secret-token" }))
    vi.stubGlobal("fetch", fetch)
    const mint = () => POST(new Request("http://localhost/api/scribe", {
      method: "POST", headers: { "x-forwarded-for": "203.0.113.4" },
    }))
    const results = []
    for (let i = 0; i < 12; i++) results.push(await mint())
    const refused = results.find((response) => response.status === 429)
    expect(refused).toBeDefined()
    expect(Number(refused!.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)
    expect(fetch.mock.calls.length).toBe(results.filter((r) => r.status === 200).length)
  })
})
