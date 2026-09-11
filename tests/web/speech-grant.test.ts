import { describe, expect, it } from "vitest"
import { grantAllows, grantFor } from "@/lib/speech-grant"

describe("proof that the room said this", () => {
  it("accepts exactly what was signed", () => {
    const grant = grantFor("Steve", "the deploy is green")
    expect(grantAllows("Steve", "the deploy is green", grant)).toBe(true)
  })

  it("refuses a different speaker, different words, or no grant at all", () => {
    const grant = grantFor("Steve", "the deploy is green")
    expect(grantAllows("Jordan", "the deploy is green", grant)).toBe(false)
    expect(grantAllows("Steve", "the deploy is red", grant)).toBe(false)
    expect(grantAllows("Steve", "the deploy is green", null)).toBe(false)
    expect(grantAllows("Steve", "the deploy is green", "")).toBe(false)
    expect(grantAllows("Steve", "the deploy is green", "not-a-grant")).toBe(false)
  })

  it("cannot be re-cut by moving the boundary between name and words", () => {
    // Without a length prefix these two would sign identical bytes, and a
    // grant issued for one would speak the other.
    expect(grantFor("A", "B:C")).not.toBe(grantFor("A:B", "C"))
    expect(grantAllows("A:B", "C", grantFor("A", "B:C"))).toBe(false)
  })

  it("does not throw on a grant of the wrong length", () => {
    expect(() => grantAllows("Steve", "hello", "x")).not.toThrow()
    expect(grantAllows("Steve", "hello", "x".repeat(500))).toBe(false)
  })
})
