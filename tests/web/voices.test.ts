import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { TTS_MODEL } from "@/lib/elevenlabs"
import { sayable, VOICES, voiceFor } from "@/lib/voices"

/**
 * The file both languages read.
 *
 * This used to parse `src/policy/voice.py` from TypeScript, because each side
 * held its own copy of the list and the only thing standing between them and
 * drift was a test that noticed afterwards. Now there is one file, and what is
 * worth testing is that this side reads it correctly.
 */
function shared(): { model: string; voices: { id: string }[] } {
  return JSON.parse(readFileSync(join(__dirname, "..", "..", "speech.json"), "utf8"))
}

describe("an agent's voice", () => {
  it("is the list in speech.json, in the order that file gives", () => {
    expect(VOICES).toEqual(shared().voices.map((voice) => voice.id))
  })

  it("uses the model that file names, so the browser cannot synthesise with another", () => {
    expect(TTS_MODEL).toBe(shared().model)
  })

  it("gives every agent in a group a different one", () => {
    const group = ["Anna", "Jordan", "Pepe"]
    const heard = group.map((n) => voiceFor(n, group))
    expect(new Set(heard).size).toBe(3)
  })

  it("does not depend on the order the group was listed in", () => {
    expect(voiceFor("Pepe", ["Anna", "Jordan", "Pepe"])).toBe(
      voiceFor("Pepe", ["Pepe", "Anna", "Jordan"]),
    )
  })

  it("still answers for an agent with no group to place it in", () => {
    expect(VOICES).toContain(voiceFor("Anna"))
  })
})

describe("what a voice is asked to read", () => {
  it("drops the emoji instead of pronouncing them", () => {
    expect(sayable("Nice one 👋")).toBe("Nice one")
    expect(sayable("Done ✅ and shipped 🚀")).toBe("Done and shipped")
  })

  it("does not leave a gap where one was", () => {
    expect(sayable("Ready 🎉.")).toBe("Ready.")
  })

  it("leaves ordinary words alone", () => {
    expect(sayable("  Thursday works on my end.  ")).toBe("Thursday works on my end.")
  })
})

describe("the turn does not wait to be able to speak", () => {
  it("keeps media an agent attached itself, which is not its voice", async () => {
    // A file an agent wrote and meant to send still travels as MEDIA. Only
    // the synthesised clip left the turn.
    const { splitAudio } = await import("@/lib/group")
    expect(splitAudio("MEDIA:/tmp/a.mp3\nOn my way.")).toEqual({
      audio: "/tmp/a.mp3",
      text: "On my way.",
    })
  })
})

describe("the file itself", () => {
  it("names a model and enough distinct voices for a full cast", () => {
    // Ten personas, so ten voices: a room can deal every one of them a
    // different person and still give each a voice of its own. A duplicate in
    // here means two of any three agents share a voice however they are
    // assigned, which happened once and the hashing took the blame for it.
    const { model, voices } = shared()
    expect(model).toBeTruthy()
    expect(voices).toHaveLength(10)
    expect(new Set(voices.map((voice) => voice.id)).size).toBe(10)
  })
})
