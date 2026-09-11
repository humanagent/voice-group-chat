import { afterEach, describe, expect, it, vi } from "vitest"
import { isMine, playerName, readPlayer, refusal, speakerFor, UNNAMED, writePlayer } from "@/lib/player"

const agents = ["Steve", "Jordan", "Pepe"]

function storage(): Storage {
  const held = new Map<string, string>()
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
    clear: () => held.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
}

afterEach(() => vi.unstubAllGlobals())

describe("the name a person claims", () => {
  it("takes an ordinary name", () => {
    expect(playerName("Fabri", agents)).toBe("Fabri")
    expect(playerName("  Alf  ", agents)).toBe("Alf")
  })

  it("refuses an agent's name, whatever the casing", () => {
    // Not etiquette. Every line goes to `audienceFor(group, speaker)`, which is
    // everyone EXCEPT the speaker — so a person called Steve would be the one
    // member of the room Steve never hears.
    expect(playerName("Steve", agents)).toBeNull()
    expect(playerName("steve", agents)).toBeNull()
    expect(refusal("steve", agents)).toBe("Steve is already in the room.")
  })

  it("refuses the room's own machinery and the unnamed placeholder", () => {
    expect(playerName("System", agents)).toBeNull()
    expect(playerName("you", agents)).toBeNull()
  })

  it("refuses anything that would break the speaker prefix", () => {
    // The transcript recovers who spoke from `Name: text`. A colon or a newline
    // in the name lets one line claim to be two, or to be somebody else's.
    expect(playerName("Steve: hello", agents)).toBeNull()
    expect(playerName("Fabri\nSteve", agents)).toBeNull()
    expect(playerName("x".repeat(25), agents)).toBeNull()
    expect(playerName("   ", agents)).toBeNull()
  })
})

describe("whose line is this", () => {
  it("keeps every message from before names existed on the reader's side", () => {
    // Rooms opened before this are full of `you:`. Reading them as somebody
    // else's would flip the whole transcript to the far side on first load.
    expect(isMine(UNNAMED, "Fabri")).toBe(true)
    expect(isMine(UNNAMED, "")).toBe(true)
  })

  it("recognises the reader however they capitalised it that day", () => {
    expect(isMine("Fabri", "Fabri")).toBe(true)
    expect(isMine("fabri", "Fabri")).toBe(true)
  })

  it("does not hand one player another player's messages", () => {
    // Two people share a room across sittings: Alf played, Fabri came back.
    expect(isMine("Alf", "Fabri")).toBe(false)
    expect(isMine("Steve", "Fabri")).toBe(false)
    expect(isMine("Alf", "")).toBe(false)
  })
})

describe("what rides in front of a line", () => {
  it("is the name when there is one, and the old placeholder when there is not", () => {
    expect(speakerFor("Fabri")).toBe("Fabri")
    expect(speakerFor("")).toBe(UNNAMED)
  })
})

describe("remembering the player", () => {
  it("keeps the name across sittings", () => {
    vi.stubGlobal("localStorage", storage())
    writePlayer("Fabri")
    expect(readPlayer()).toBe("Fabri")
    writePlayer("")
    expect(readPlayer()).toBe("")
  })

  it("opens the room anyway when storage is unreadable", () => {
    // A private window throws on access rather than returning null, and the
    // room worked without a name before it had one.
    const blocked = { getItem() { throw new Error("denied") }, setItem() { throw new Error("denied") }, removeItem() { throw new Error("denied") } }
    vi.stubGlobal("localStorage", blocked as unknown as Storage)
    expect(readPlayer()).toBe("")
    expect(() => writePlayer("Fabri")).not.toThrow()
  })

  it("ignores a stored value that is no longer a usable name", () => {
    vi.stubGlobal("localStorage", storage())
    localStorage.setItem("room.player", "Steve: hi")
    expect(readPlayer()).toBe("")
  })
})
