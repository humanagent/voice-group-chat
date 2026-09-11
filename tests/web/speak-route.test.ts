import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ElevenLabsError } from "@elevenlabs/elevenlabs-js"
import { GET } from "@/app/api/speak/route"
import { forgetBudget, MONTHLY_CHARACTERS } from "@/lib/budget"
import { forgetLimiters } from "@/lib/rate-limit"
import { grantFor } from "@/lib/speech-grant"

// The SDK client is the seam. Stubbing `fetch` would be testing the SDK's
// transport instead of this route's decisions.
const upstream = vi.hoisted(() => ({ convertWithTimestamps: vi.fn() }))
vi.mock("@/lib/elevenlabs", async (original) => ({
  ...(await original<typeof import("@/lib/elevenlabs")>()),
  key: vi.fn(() => "test-only-key"),
  client: vi.fn(() => ({ textToSpeech: { convertWithTimestamps: upstream.convertWithTimestamps } })),
}))
vi.mock("@/lib/agents", () => ({ agents: vi.fn(() => [{ name: "Steve", url: "http://a", key: "k" }]) }))

const LINE = "the deploy is green"
function ask(params: Record<string, string>, headers: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString()
  return GET(new Request(`http://localhost/api/speak?${query}`, { headers }))
}
const spoken = () => ({ agent: "Steve", text: LINE, grant: grantFor("Steve", LINE) })

let root: string
beforeEach(() => {
  forgetLimiters()
  // The cache and the month's allowance are both files. Given nowhere of their
  // own they would be the developer's real ones.
  root = mkdtempSync(join(tmpdir(), "room-speak-"))
  process.env.HERMES_GROUP_STATE = root
  forgetBudget()
  vi.clearAllMocks()
  upstream.convertWithTimestamps.mockResolvedValue({
    audioBase64: "AAAA",
    alignment: {
      characters: [...LINE],
      characterStartTimesSeconds: [...LINE].map((_, i) => i / 10),
      characterEndTimesSeconds: [...LINE].map((_, i) => (i + 1) / 10),
    },
  })
})
afterEach(() => {
  forgetBudget()
  rmSync(root, { recursive: true, force: true })
  delete process.env.HERMES_GROUP_STATE
  delete process.env[MONTHLY_CHARACTERS]
  delete process.env.SPEECH_ENABLED
  vi.restoreAllMocks()
})

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

  it("asks for the agent's own voice and the model this project pins", async () => {
    const { TTS_MODEL } = await import("@/lib/elevenlabs")
    await ask({ ...spoken(), voice: "somebody-elses-voice" })
    const [voiceId, body, options] = upstream.convertWithTimestamps.mock.calls[0]
    expect(voiceId).toMatch(/^[A-Za-z0-9]{20}$/)
    expect(voiceId).not.toBe("somebody-elses-voice")
    // Half the bytes of the default at the same sample rate: this is base64 in
    // JSON on its way down a phone network, and nobody hears the difference
    // through a phone speaker.
    expect(body).toEqual({ text: LINE, modelId: TTS_MODEL, outputFormat: "mp3_44100_64" })
    // A turn somebody is waiting through: bounded, cancellable, and not
    // retried until the audio is worth less than the wait.
    expect(options.maxRetries).toBe(1)
    expect(options.timeoutInSeconds).toBe(30)
    expect(options.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it("strips emoji on the way to the voice and leaves the written line alone", async () => {
    const text = `${LINE} 🚀`
    await ask({ agent: "Steve", text, grant: grantFor("Steve", text) })
    expect(upstream.convertWithTimestamps.mock.calls[0][1].text).toBe(LINE)
  })
})

describe("refusing to be an open synthesiser", () => {
  it("will not speak text the room never said", async () => {
    const response = await ask({ agent: "Steve", text: "read out my advertisement", grant: grantFor("Steve", LINE) })
    expect(response.status).toBe(403)
    expect(upstream.convertWithTimestamps).not.toHaveBeenCalled()
  })

  it("will not speak without a grant at all", async () => {
    expect((await ask({ agent: "Steve", text: LINE })).status).toBe(403)
    expect(upstream.convertWithTimestamps).not.toHaveBeenCalled()
  })

  it("will not lend one agent's grant to another", async () => {
    const response = await ask({ agent: "Jordan", text: LINE, grant: grantFor("Steve", LINE) })
    expect(response.status).toBe(403)
    expect(upstream.convertWithTimestamps).not.toHaveBeenCalled()
  })

  it("refuses a page that is not this one", async () => {
    const response = await ask(spoken(), { origin: "https://somewhere.example", host: "localhost" })
    expect(response.status).toBe(403)
    expect(upstream.convertWithTimestamps).not.toHaveBeenCalled()
  })

  it("caps how long a line can be before it does any work", async () => {
    const long = "a".repeat(1001)
    const response = await ask({ agent: "Steve", text: long, grant: grantFor("Steve", long) })
    expect(response.status).toBe(413)
    expect(upstream.convertWithTimestamps).not.toHaveBeenCalled()
  })

  it("stops a caller asking for the same line over and over", async () => {
    const results = []
    for (let i = 0; i < 20; i++) results.push((await ask(spoken(), { "x-forwarded-for": "203.0.113.5" })).status)
    expect(results).toContain(429)
    // Asked twenty times and synthesised once: the bucket refuses the tail of
    // it, and the cache answers everything in between without a provider call.
    expect(upstream.convertWithTimestamps).toHaveBeenCalledTimes(1)
  })

  it("says how long to wait when it refuses", async () => {
    let last = await ask(spoken(), { "x-forwarded-for": "203.0.113.6" })
    for (let i = 0; i < 20 && last.status !== 429; i++) last = await ask(spoken(), { "x-forwarded-for": "203.0.113.6" })
    expect(last.status).toBe(429)
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)
  })
})

describe("when the synthesiser will not answer", () => {
  it("reports the status and request id, and never the provider's own words", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    upstream.convertWithTimestamps.mockRejectedValueOnce(new ElevenLabsError({
      message: "quota exceeded", statusCode: 401,
      body: { detail: "the deploy is green was rejected" },
      rawResponse: { headers: new Headers({ "request-id": "req_abc123" }) } as never,
    }))
    const response = await ask(spoken())
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain("the deploy is green was rejected")
    const logged = JSON.parse(warn.mock.calls[0][0] as string)
    expect(logged).toMatchObject({ event: "speech.synthesis_failed", upstreamStatus: 401 })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("was rejected")
  })

  it("survives a failure that is not the provider answering at all", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    upstream.convertWithTimestamps.mockRejectedValueOnce(new Error("socket hang up"))
    const response = await ask(spoken())
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain("socket hang up")
  })

  it("does not claim success for a response with no audio in it", async () => {
    upstream.convertWithTimestamps.mockResolvedValueOnce({ audioBase64: "" })
    expect((await ask(spoken())).status).toBe(502)
  })
})

describe("when the room is not configured to speak", () => {
  it("says so rather than pretending, and never calls upstream", async () => {
    const { key } = await import("@/lib/elevenlabs")
    vi.mocked(key).mockReturnValueOnce("")
    expect((await ask(spoken())).status).toBe(503)
    expect(upstream.convertWithTimestamps).not.toHaveBeenCalled()
  })

  it("refuses an agent that is not in this group", async () => {
    const response = await ask({ agent: "Nobody", text: LINE, grant: grantFor("Nobody", LINE) })
    expect(response.status).toBe(400)
    expect(upstream.convertWithTimestamps).not.toHaveBeenCalled()
  })
})

describe("what a spoken line costs", () => {
  it("says the same line twice and pays once", async () => {
    expect((await ask(spoken())).status).toBe(200)
    const again = await ask(spoken())
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ audio: "AAAA" })
    // The second one never reached ElevenLabs, which is the whole point: a
    // transcript people scroll back through replays lines for free.
    expect(upstream.convertWithTimestamps).toHaveBeenCalledTimes(1)
  })

  it("stops speaking when the month is spent, and says so without spending more", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {})
    process.env[MONTHLY_CHARACTERS] = String(LINE.length)
    expect((await ask(spoken())).status).toBe(200)
    const other = "a second line entirely"
    const response = await ask({ agent: "Steve", text: other, grant: grantFor("Steve", other) })
    expect(response.status).toBe(503)
    expect(upstream.convertWithTimestamps).toHaveBeenCalledTimes(1)
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ event: "speech.budget_spent" })
    // And the line it already knows is still free.
    expect((await ask(spoken())).status).toBe(200)
    expect(upstream.convertWithTimestamps).toHaveBeenCalledTimes(1)
  })

  it("goes off the air on a switch, with the key still in place", async () => {
    process.env.SPEECH_ENABLED = "0"
    expect((await ask(spoken())).status).toBe(503)
    expect(upstream.convertWithTimestamps).not.toHaveBeenCalled()
  })
})

describe("the line before this one", () => {
  const before = "and how did the deploy go?"
  it("is given to the voice as context when the room can prove it said that too", async () => {
    await ask({ ...spoken(), previous: before, previousAgent: "Steve", previousGrant: grantFor("Steve", before) })
    expect(upstream.convertWithTimestamps.mock.calls[0][1]).toMatchObject({ previousText: before })
  })

  it("is dropped, never refused, when it is not something this room said", async () => {
    const response = await ask({ ...spoken(), previous: before, previousAgent: "Steve", previousGrant: "forged" })
    // Context is an improvement. A bad one costs the prosody, not the sentence.
    expect(response.status).toBe(200)
    expect(upstream.convertWithTimestamps.mock.calls[0][1].previousText).toBeUndefined()
  })

  it("is left out when it is a paragraph rather than a breath", async () => {
    const long = "x".repeat(400)
    await ask({ ...spoken(), previous: long, previousAgent: "Steve", previousGrant: grantFor("Steve", long) })
    expect(upstream.convertWithTimestamps.mock.calls[0][1].previousText).toBeUndefined()
  })
})
