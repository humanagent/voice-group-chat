import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { TTS_MODEL } from "@/lib/elevenlabs"
import { sayable, VOICES, voiceFor } from "@/lib/voices"

/**
 * The runtime's list, read out of the Python rather than trusted to match.
 *
 * Both sides of this project speak now — the browser streams a reply, the
 * terminal client synthesises one — and they decide the voice independently
 * from the same list. An agent that sounded like two different people
 * depending on where you were watching would be worse than one that stayed
 * silent, and nothing else would catch that drift.
 */
function runtimeVoices(): string[] {
  const py = readFileSync(join(__dirname, "..", "..", "src", "policy", "voice.py"), "utf8")
  const block = py.slice(py.indexOf("VOICES = ["), py.indexOf("]", py.indexOf("VOICES = [")))
  return [...block.matchAll(/"([A-Za-z0-9]{20})"/g)].map((m) => m[1])
}

describe("an agent's voice", () => {
  it("is the same list the runtime uses, in the same order", () => {
    expect(VOICES).toEqual(runtimeVoices())
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

describe("the model that speaks", () => {
  it("is the one the runtime names, not a second copy of it", () => {
    // `TTS_MODEL` is written in `src/defaults.py` and again in TypeScript,
    // because a Next.js route cannot read a Python module. The runtime picks
    // it for a measured reason — flash is the one built for live conversation
    // — and a browser quietly synthesising with something else would be slower
    // or more expensive for reasons nobody could see.
    const py = readFileSync(
      join(__dirname, "..", "..", "src", "defaults.py"),
      "utf8",
    )
    const named = /^TTS_MODEL = "([^"]+)"/m.exec(py)?.[1]
    expect(named).toBeTruthy()
    expect(TTS_MODEL).toBe(named)
  })
})
