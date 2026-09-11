import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GET } from "@/app/api/audio/route"
import { forgetLimiters } from "@/lib/rate-limit"

vi.mock("@/lib/agents", () => ({ agents: vi.fn(() => [{ name: "Anna", url: "http://a", key: "k" }]) }))

let root: string
let clip: string
let outsider: string
beforeEach(() => {
  forgetLimiters()
  root = mkdtempSync(join(tmpdir(), "room-clips-route-"))
  process.env.HERMES_GROUP_STATE = root
  const home = join(root, ".hermes-anna", "cache", "audio")
  mkdirSync(home, { recursive: true })
  clip = join(home, "tts_20260910_120000.mp3")
  writeFileSync(clip, "not really an mp3, but it is where one would be")
  outsider = join(root, "elsewhere.mp3")
  writeFileSync(outsider, "a file this room did not make")
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.HERMES_GROUP_STATE
})

const ask = (path: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost/api/audio?path=${encodeURIComponent(path)}`, { headers }))

describe("serving a clip an agent made", () => {
  it("serves one out of an agent's own home, immutably", async () => {
    const response = await ask(clip)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("audio/mpeg")
    expect(response.headers.get("cache-control")).toContain("immutable")
  })

  it("refuses a file from anywhere else, however it is spelled", async () => {
    expect((await ask(outsider)).status).toBe(403)
    expect((await ask(join(root, ".hermes-anna", "cache", "audio", "..", "..", "..", "elsewhere.mp3"))).status).toBe(403)
    expect((await ask("/etc/passwd")).status).toBe(400)
    expect((await ask(join(root, ".hermes-anna", "cache", "audio", "notes.txt"))).status).toBe(400)
  })

  it("answers this room's pages and not a page somewhere else", async () => {
    expect((await ask(clip, { origin: "http://localhost", host: "localhost" })).status).toBe(200)
    // The drive-by this shuts: a page elsewhere embedding the room's clips.
    expect((await ask(clip, { origin: "https://somewhere.example", host: "localhost" })).status).toBe(403)
    expect((await ask(clip, { "sec-fetch-site": "cross-site" })).status).toBe(403)
  })

  it("stops one caller pulling clips without end", async () => {
    const results = []
    for (let index = 0; index < 40; index++) {
      results.push((await ask(clip, { "x-forwarded-for": "203.0.113.9" })).status)
    }
    expect(results).toContain(429)
  })
})
