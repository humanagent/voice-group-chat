import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ElevenLabsError } from "@elevenlabs/elevenlabs-js"
import { POST } from "@/app/api/scribe/route"
import { forgetBudget, MONTHLY_SESSIONS } from "@/lib/budget"
import { LISTEN_GATE, TTS_LANGUAGE } from "@/lib/elevenlabs"
import { forgetLimiters } from "@/lib/rate-limit"

const upstream = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock("@/lib/elevenlabs", async (original) => ({
  ...(await original<typeof import("@/lib/elevenlabs")>()),
  key: vi.fn(() => "test-only-key"),
  client: vi.fn(() => ({ tokens: { singleUse: { create: upstream.create } } })),
}))

// Buckets outlive a request by design, so each test starts from a full one.
let root: string
beforeEach(() => {
  forgetLimiters()
  root = mkdtempSync(join(tmpdir(), "room-scribe-"))
  process.env.HERMES_GROUP_STATE = root
  forgetBudget()
  vi.clearAllMocks()
})
afterEach(() => {
  forgetBudget()
  rmSync(root, { recursive: true, force: true })
  delete process.env.HERMES_GROUP_STATE
  delete process.env[MONTHLY_SESSIONS]
  delete process.env.SPEECH_ENABLED
  vi.restoreAllMocks()
})

/** What the room says about listening, beside the token. Absent when it is
 *  letting every session decide for itself, which is its default for language. */
const room = { ...(TTS_LANGUAGE ? { language: TTS_LANGUAGE } : {}), ...(LISTEN_GATE > 0 ? { gate: LISTEN_GATE } : {}) }

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
    expect(await response.json()).toEqual({ token: "secret-token", ...room })
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

describe("what the room tells the microphone", () => {
  it("ships the gate with the token, so the browser stops sending the room", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    upstream.create.mockResolvedValue({ token: "secret-token" })
    const body = await (await POST(request())).json()
    // Set in `speech.json`, where the voices are, because how loud somebody has
    // to be is part of what this room sounds like.
    expect(body.gate).toBe(LISTEN_GATE)
    expect(body.gate).toBeGreaterThan(0)
    expect(body.gate).toBeLessThan(1)
  })

  it("stops minting tokens when the month is spent", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    upstream.create.mockResolvedValue({ token: "secret-token" })
    process.env[MONTHLY_SESSIONS] = "1"
    expect((await POST(request())).status).toBe(200)
    const response = await POST(request())
    expect(response.status).toBe(503)
    // Refused here rather than upstream: a token handed out is a session spent.
    expect(upstream.create).toHaveBeenCalledTimes(1)
  })

  it("goes off the air on a switch, with the key still in place", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    process.env.SPEECH_ENABLED = "0"
    expect((await POST(request())).status).toBe(503)
    expect(upstream.create).not.toHaveBeenCalled()
  })
})
