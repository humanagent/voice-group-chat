import { describe, expect, it } from "vitest"

import { worthSending } from "@/lib/listening"
import { upTo } from "@/lib/speaking"

describe("what counts as somebody talking", () => {
  it("takes a one-word answer", () => {
    expect(worthSending("sí")).toBe(true)
    expect(worthSending("stop")).toBe(true)
  })

  it("drops the noises a room makes", () => {
    expect(worthSending("uh")).toBe(false)
    expect(worthSending("mm, hmm")).toBe(false)
    expect(worthSending("[BLANK_AUDIO]")).toBe(false)
    expect(worthSending("(música)")).toBe(false)
    expect(worthSending("   ...  ")).toBe(false)
  })

  it("keeps a filler that is part of a sentence", () => {
    expect(worthSending("uh what do you think")).toBe(true)
  })
})

describe("following a voice through a line", () => {
  const line = "Rollback drill came in at 87 seconds."

  it("paints nothing before a word is reached, and the word once it starts", () => {
    expect(line.slice(0, upTo(line, line, 0))).toBe("")
    expect(line.slice(0, upTo(line, line, 3))).toBe("Rollback")
    expect(line.slice(0, upTo(line, line, 9))).toBe("Rollback drill")
  })

  it("never leaves half a word in one colour", () => {
    for (let n = 0; n <= line.length; n++) {
      const cut = upTo(line, line, n)
      // Whatever is painted ends where a word ends: at the edge of the line,
      // or with whitespace waiting on the other side of the boundary.
      expect(cut === 0 || cut === line.length || /\s/.test(line[cut])).toBe(true)
    }
  })

  it("walks the written line back onto what was actually said", () => {
    // The emoji never reached the synthesiser, so its characters are not in
    // the timings and must not shift the boundary.
    const written = "Morning 👋 all good."
    const said = "Morning all good."
    expect(written.slice(0, upTo(written, said, 9))).toBe("Morning 👋 all")
  })

  it("shows a line whole when there is nothing to follow", () => {
    expect(upTo(line, "", 0)).toBe(line.length)
    expect(upTo(line, "something else entirely", 4)).toBe(line.length)
  })
})
