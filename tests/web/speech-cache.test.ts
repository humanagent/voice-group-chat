import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clipKey, readClip, writeClip } from "@/lib/speech-cache"

let root: string
const clips = () => join(root, ".hermes", "speech", "clips")
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "room-clips-"))
  process.env.HERMES_GROUP_STATE = root
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.HERMES_GROUP_STATE
  delete process.env.SPEECH_CACHE
})

const said = { voice: "voice-one", model: "eleven_flash_v2_5", language: null, format: "mp3_44100_64", text: "the deploy is green" }
const clip = { audio: "AAAA", chars: [..."the deploy is green"], starts: [0, 0.1] }

describe("a line already said", () => {
  it("comes back without asking the provider again", () => {
    const key = clipKey(said)
    expect(readClip(key)).toBeNull()
    writeClip(key, clip)
    expect(readClip(key)).toEqual(clip)
  })

  it("is a different clip when anything that decides it changes", () => {
    const key = clipKey(said)
    const others = [
      { ...said, voice: "voice-two" },
      { ...said, model: "eleven_multilingual_v2" },
      { ...said, language: "es" },
      { ...said, format: "mp3_44100_128" },
      { ...said, text: "the deploy is red" },
    ]
    for (const other of others) expect(clipKey(other)).not.toBe(key)
    // And the same request is the same key, every time and in any process.
    expect(clipKey({ ...said })).toBe(key)
    expect(key).toMatch(/^[a-f0-9]{64}$/)
  })

  it("keeps the text out of the cache directory", () => {
    writeClip(clipKey(said), clip)
    expect(readdirSync(clips()).join(" ")).not.toContain("deploy")
  })

  it("refuses half a clip rather than handing the player nothing", () => {
    const key = clipKey(said)
    writeClip(key, clip)
    writeFileSync(join(clips(), `${key}.json`), '{"audio":')
    expect(readClip(key)).toBeNull()
    writeFileSync(join(clips(), `${key}.json`), JSON.stringify({ audio: "", chars: [], starts: [] }))
    expect(readClip(key)).toBeNull()
  })

  it("can be turned off, and then remembers nothing", () => {
    process.env.SPEECH_CACHE = "0"
    const key = clipKey(said)
    writeClip(key, clip)
    expect(readClip(key)).toBeNull()
    delete process.env.SPEECH_CACHE
    expect(readClip(key)).toBeNull()
  })

  it("drops the oldest when the room outgrows it", () => {
    for (let index = 0; index < 520; index++) {
      writeClip(clipKey({ ...said, text: `line ${index}` }), { ...clip, audio: `A${index}` })
    }
    const kept = readdirSync(clips()).filter((name) => name.endsWith(".json"))
    expect(kept.length).toBeLessThanOrEqual(500)
    // The most recent survive, which is the half of a conversation anybody is
    // still looking at.
    expect(readClip(clipKey({ ...said, text: "line 519" }))).not.toBeNull()
  })

  it("costs nothing when the state directory cannot be written", () => {
    process.env.HERMES_GROUP_STATE = "/dev/null/not-a-directory"
    const key = clipKey(said)
    expect(() => writeClip(key, clip)).not.toThrow()
    expect(readClip(key)).toBeNull()
  })
})
