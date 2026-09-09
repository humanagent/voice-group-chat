import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET } from "@/app/api/speak/route"
import { forgetLimiters } from "@/lib/rate-limit"
import { grantFor } from "@/lib/speech-grant"

vi.mock("@/lib/elevenlabs", async (original) => ({
  ...(await original<typeof import("@/lib/elevenlabs")>()),
  key: vi.fn(() => "test-only-key"),
}))
vi.mock("@/lib/agents", () => ({ agents: vi.fn(() => [{ name: "Anna", url: "http://a", key: "k" }]) }))

const LINE = "the deploy is green"
function ask(params: Record<string, string>, headers: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString()
  return GET(new Request(`http://localhost/api/speak?${query}`, { headers }))
}
const spoken = () => ({ agent: "Anna", text: LINE, grant: grantFor("Anna", LINE) })

let upstream: ReturnType<typeof vi.fn>
beforeEach(() => {
  forgetLimiters()
  upstream = vi.fn(async () => Response.json({
    audio_base64: "AAAA",
    alignment: { characters: [...LINE], character_start_times_seconds: [...LINE].map((_, i) => i / 10) },
  }))
  vi.stubGlobal("fetch", upstream)
})
afterEach(() => { vi.unstubAllGlobals() })

describe("speaking a line the room said", () => {
  it("synthesises it and returns the timings the transcript follows", async () => {
    const response = await ask(spoken())
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.audio).toBe("AAAA")
    expect(body.chars.join("")).toBe(LINE)
    expect(body.starts).toHaveLength(LINE.length)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("asks ElevenLabs for the agent's own voice, and never the caller's choice", async () => {
    await ask({ ...spoken(), voice: "somebody-elses-voice" })
    const [url, options] = upstream.mock.calls[0]
    expect(url).toContain("/with-timestamps")
    expect(url).not.toContain("somebody-elses-voice")
    expect(JSON.parse(options.body).text).toBe(LINE)
  })
})

describe("refusing to be an open synthesiser", () => {
  it("will not speak text the room never said", async () => {
    const response = await ask({ agent: "Anna", text: "read out my advertisement", grant: grantFor("Anna", LINE) })
    expect(response.status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("will not speak without a grant at all", async () => {
    expect((await ask({ agent: "Anna", text: LINE })).status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("will not lend one agent's grant to another", async () => {
    const response = await ask({ agent: "Jordan", text: LINE, grant: grantFor("Anna", LINE) })
    expect(response.status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("refuses a page that is not this one", async () => {
    const response = await ask(spoken(), { origin: "https://somewhere.example", host: "localhost" })
    expect(response.status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("caps how long a line can be before it does any work", async () => {
    const long = "a".repeat(1001)
    const response = await ask({ agent: "Anna", text: long, grant: grantFor("Anna", long) })
    expect(response.status).toBe(413)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("stops a caller asking for the same line over and over", async () => {
    const results = []
    for (let i = 0; i < 20; i++) results.push((await ask(spoken(), { "x-forwarded-for": "203.0.113.5" })).status)
    expect(results).toContain(429)
    // Charged only for what it would actually have synthesised.
    expect(upstream.mock.calls.length).toBe(results.filter((status) => status === 200).length)
  })

  it("says how long to wait when it refuses", async () => {
    let last = await ask(spoken(), { "x-forwarded-for": "203.0.113.6" })
    for (let i = 0; i < 20 && last.status !== 429; i++) last = await ask(spoken(), { "x-forwarded-for": "203.0.113.6" })
    expect(last.status).toBe(429)
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)
  })
})

describe("when the room is not configured to speak", () => {
  it("says so rather than pretending, and never calls upstream", async () => {
    const { key } = await import("@/lib/elevenlabs")
    vi.mocked(key).mockReturnValueOnce("")
    expect((await ask(spoken())).status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("refuses an agent that is not in this group", async () => {
    const response = await ask({ agent: "Nobody", text: LINE, grant: grantFor("Nobody", LINE) })
    expect(response.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })
})
