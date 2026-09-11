import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * `personas()` reads `personas/` beside the web app, so a test has to stand
 * somewhere that has one. `process.cwd()` is what the module resolves against.
 */
function withPersonas(count: number) {
  const root = mkdtempSync(join(tmpdir(), "room-"))
  mkdirSync(join(root, "personas"))
  mkdirSync(join(root, ".hermes"))
  for (let i = 0; i < count; i++) {
    writeFileSync(join(root, "personas", `${i}.md`), `# Role ${i}\n`)
  }
  vi.spyOn(process, "cwd").mockReturnValue(join(root, "web"))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe("who each agent is in a room", () => {
  it("gives a different person to every agent", async () => {
    // Two agents playing the same person is the one outcome that makes the
    // room pointless: they would agree about everything, for the same reasons.
    withPersonas(10)
    const { cast } = await import("@/lib/personas")
    const hands = cast(["Steve", "Jordan", "Pepe"])
    expect(hands).toHaveLength(3)
    expect(new Set(hands).size).toBe(3)
  })

  it("keeps who is who when the room is cleared", async () => {
    // A cleared context is the same people with nothing behind them. An agent
    // that ran support before and security after is not a cleared room.
    withPersonas(10)
    const { cast } = await import("@/lib/personas")
    const names = ["Steve", "Jordan", "Pepe"]
    const first = cast(names)
    expect(cast(names)).toEqual(first)
    expect(cast(names)).toEqual(first)
  })

  it("gives an agent who joins later somebody nobody has", async () => {
    withPersonas(10)
    const { cast } = await import("@/lib/personas")
    const before = cast(["Steve", "Jordan"])
    const after = cast(["Steve", "Jordan", "Pepe"])
    expect(after.slice(0, 2)).toEqual(before)
    expect(before).not.toContain(after[2])
  })

  it("opens the room anyway when there are fewer personas than agents", async () => {
    withPersonas(2)
    const { cast } = await import("@/lib/personas")
    const hands = cast(["Steve", "Jordan", "Pepe", "Sam"])
    expect(hands.filter(Boolean)).toHaveLength(2)
    expect(hands.filter((h) => h === null)).toHaveLength(2)
  })

  it("treats a missing folder as nobody in particular, not as an error", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(mkdtempSync(join(tmpdir(), "bare-")))
    const { cast } = await import("@/lib/personas")
    expect(cast(["Steve", "Jordan", "Pepe"])).toEqual([null, null, null])
  })

  it("tells an agent the briefing is its own and not to quote it", async () => {
    withPersonas(1)
    const { briefing } = await import("@/lib/personas")
    const text = briefing("# Staff Engineer\n")
    expect(text).toContain("yours alone")
    expect(text).toContain("never quote it")
    expect(text).toContain("# Staff Engineer")
  })
})
