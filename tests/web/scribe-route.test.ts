import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ElevenLabsError } from "@elevenlabs/elevenlabs-js"
import { POST } from "@/app/api/scribe/route"
import { forgetLimiters } from "@/lib/rate-limit"

const upstream = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock("@/lib/elevenlabs", async (original) => ({
  ...(await original<typeof import("@/lib/elevenlabs")>()),
  key: vi.fn(() => "test-only-key"),
  client: vi.fn(() => ({ tokens: { singleUse: { create: upstream.create } } })),
}))

// Buckets outlive a request by design, so each test starts from a full one.
beforeEach(() => { forgetLimiters(); vi.clearAllMocks() })
afterEach(() => { vi.restoreAllMocks() })

const requestId = "09f21ee4-fd37-4b3c-b8ee-1d3c7ba076d7"
const request = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/scribe", { method: "POST", headers: { "x-request-id": requestId, ...headers } })

function refusal(statusCode: number, detail: string, id?: string) {
  return new ElevenLabsError({
    message: "request failed", statusCode, body: { detail },
    rawResponse: { headers: new Headers(id ? { "x-request-id": id } : {}) } as never,
  })
}

describe("single-use transcription token diagnostics", () => {
  it("correlates the request, disables caching and never logs the token or API key", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    upstream.create.mockResolvedValue({ token: "secret-token" })
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-request-id")).toBe(requestId)
    expect(await response.json()).toEqual({ token: "secret-token" })
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ event: "speech.token", requestId, outcome: "ready" })
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret-token|test-only-key/)
  })

  it("asks for the token type by the SDK's own name, bounded and cancellable", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    upstream.create.mockResolvedValue({ token: "secret-token" })
    await POST(request())
    const [type, options] = upstream.create.mock.calls[0]
    expect(type).toBe("realtime_scribe")
    expect(options.timeoutInSeconds).toBe(10)
    expect(options.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it("reports provider failures using status and request id, not raw provider details", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    upstream.create.mockRejectedValue(refusal(429, "sensitive-provider-body", "req_upstream_1"))
    const response = await POST(request())
    expect(response.status).toBe(502)
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({
      outcome: "provider_error", upstreamStatus: 429, upstreamRequestId: "req_upstream_1",
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive-provider-body")
    expect(await response.text()).not.toContain("sensitive-provider-body")
  })

  it("does not claim success for missing configuration or an empty token", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    const { key } = await import("@/lib/elevenlabs")
    upstream.create.mockResolvedValue({ token: "" })
    vi.mocked(key).mockReturnValueOnce("")
    expect((await POST(request())).status).toBe(503)
    expect(upstream.create).not.toHaveBeenCalled()
    expect(JSON.parse(log.mock.calls[0][0] as string).outcome).toBe("not_configured")
    expect((await POST(request())).status).toBe(502)
    expect(JSON.parse(log.mock.calls[1][0] as string).outcome).toBe("invalid_response")
  })

  it("sanitizes network failures and ignores arbitrary correlation text", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    upstream.create.mockRejectedValue(new Error("sensitive-network-detail"))
    const response = await POST(new Request("http://localhost/api/scribe", {
      method: "POST", headers: { "x-request-id": "private-message" },
    }))
    expect(response.status).toBe(502)
    expect(JSON.parse(log.mock.calls[0][0] as string).outcome).toBe("network_error")
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-message|sensitive-network-detail/)
  })
})

describe("a token is worth something, so it is rationed", () => {
  it("refuses a page that is not this one, before reaching ElevenLabs", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    const response = await POST(request({ origin: "https://somewhere.example", host: "localhost" }))
    expect(response.status).toBe(403)
    expect(upstream.create).not.toHaveBeenCalled()
    expect(JSON.parse(log.mock.calls[0][0] as string).outcome).toBe("cross_origin")
  })

  it("stops one caller minting sessions in a loop, and says how long to wait", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    upstream.create.mockResolvedValue({ token: "secret-token" })
    const results = []
    for (let i = 0; i < 12; i++) results.push(await POST(request({ "x-forwarded-for": "203.0.113.4" })))
    const refused = results.find((response) => response.status === 429)
    expect(refused).toBeDefined()
    expect(Number(refused!.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)
    expect(upstream.create.mock.calls.length).toBe(results.filter((r) => r.status === 200).length)
  })
})
