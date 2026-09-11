import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ceiling, MONTHLY_CHARACTERS, monthOf, SpeechBudget } from "@/lib/budget"

const open: SpeechBudget[] = []
const folders: string[] = []
function store() {
  const folder = mkdtempSync(join(tmpdir(), "room-budget-"))
  folders.push(folder)
  const db = new SpeechBudget(join(folder, "budget.sqlite"))
  open.push(db)
  return db
}
afterEach(() => {
  for (const db of open.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  delete process.env[MONTHLY_CHARACTERS]
})

const january = new Date("2026-01-14T10:00:00Z")
const february = new Date("2026-02-01T00:00:00Z")

describe("what a room may spend on being heard", () => {
  it("counts what it spends and refuses the request that would go over", () => {
    process.env[MONTHLY_CHARACTERS] = "100"
    const db = store()
    expect(db.characters(60, january)).toEqual({ ok: true, used: 60, limit: 100 })
    // Refused whole. Half a spoken line is not a thing to hand somebody.
    expect(db.characters(60, january)).toEqual({ ok: false, used: 60, limit: 100 })
    expect(db.used(january).characters).toBe(60)
    // What still fits still goes through.
    expect(db.characters(40, january).ok).toBe(true)
    expect(db.used(january).characters).toBe(100)
  })

  it("starts the month over, and keeps the months apart", () => {
    process.env[MONTHLY_CHARACTERS] = "100"
    const db = store()
    db.characters(100, january)
    expect(db.characters(1, january).ok).toBe(false)
    expect(db.characters(100, february).ok).toBe(true)
    expect(db.used(january).characters).toBe(100)
    expect(db.used(february).characters).toBe(100)
  })

  it("counts transcription sessions separately from spoken characters", () => {
    const db = store()
    db.characters(500, january)
    db.session(january)
    db.session(january)
    expect(db.used(january)).toEqual({ characters: 500, sessions: 2 })
  })

  it("survives the process that wrote it", () => {
    process.env[MONTHLY_CHARACTERS] = "100"
    const folder = mkdtempSync(join(tmpdir(), "room-budget-restart-"))
    folders.push(folder)
    const path = join(folder, "budget.sqlite")
    const first = new SpeechBudget(path)
    first.characters(90, january)
    first.close()
    const second = new SpeechBudget(path)
    open.push(second)
    // A redeploy is not a fresh allowance.
    expect(second.characters(20, january).ok).toBe(false)
    expect(second.used(january).characters).toBe(90)
  })

  it("has no ceiling at zero, and never reads a typo as unlimited", () => {
    process.env[MONTHLY_CHARACTERS] = "0"
    const db = store()
    expect(db.characters(10_000_000, january)).toEqual({ ok: true, used: 0, limit: 0 })
    expect(ceiling(MONTHLY_CHARACTERS, 7)).toBe(0)
    for (const typo of ["", "  ", "lots", "-5", "1e5!", "12.5"]) {
      process.env[MONTHLY_CHARACTERS] = typo
      expect(ceiling(MONTHLY_CHARACTERS, 7)).toBe(7)
    }
    delete process.env[MONTHLY_CHARACTERS]
    expect(ceiling(MONTHLY_CHARACTERS, 7)).toBe(7)
  })

  it("names months in UTC, so the turn of one happens once", () => {
    expect(monthOf(new Date("2026-01-31T23:59:59Z"))).toBe("2026-01")
    expect(monthOf(new Date("2026-02-01T00:00:00Z"))).toBe("2026-02")
    expect(monthOf(new Date("2026-12-31T23:00:00Z"))).toBe("2026-12")
  })
})
