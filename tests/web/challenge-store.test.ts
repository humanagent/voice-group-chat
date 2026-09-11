import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChallengeStore, challengeOwner } from "@/lib/challenge-store"
import { DatabaseSync } from "node:sqlite"
import { CHALLENGE_DURATION_MS, isStanding, publicName, replies } from "@/lib/challenge"

const stores: ChallengeStore[] = []
function store(path = ":memory:") { const db = new ChallengeStore(path); stores.push(db); return db }
afterEach(() => { for (const db of stores.splice(0)) db.close() })

describe("server-owned challenge scores", () => {
  it("starts at zero, counts as high as the room gets, and stops counting when it ends", () => {
    const db = store()
    const run = db.create("owner", 100)
    expect(run.score).toBe(0)
    // Nothing at twenty, nothing at any number: the score is the count.
    for (let index = 1; index <= 30; index++) expect(db.increment(run.id, 101).score).toBe(index)
    expect(db.finish(run.id, "quiet")).toMatchObject({ score: 30, status: "quiet" })
    // A reply that lands after the round is over is not a point.
    expect(db.increment(run.id, 102).score).toBe(30)
    expect(db.scoreboard()).toEqual([])
  })
  it("requires the owner and a finished run; retries neither duplicate nor rename", () => {
    const db = store()
    const run = db.create("owner", 100)
    expect(() => db.publish(run.id, "owner", "Ada", 101)).toThrow("Finish")
    db.increment(run.id, 101)
    db.finish(run.id, "quiet")
    expect(() => db.publish(run.id, "stranger", "Fake", 102)).toThrow("not found")
    db.publish(run.id, "owner", "Ada", 102)
    db.publish(run.id, "owner", "Changed", 103)
    expect(db.scoreboard()).toEqual([{ id: expect.any(String), name: "Ada", score: 1, rank: 1 }])
    expect(db.scoreboard()[0].id).not.toBe(run.id)
    expect(JSON.stringify(db.scoreboard())).not.toContain("owner")
  })
  it("prevents simultaneous attempts and bounds per-browser and global capacity", () => {
    const db = store()
    const first = db.create("one", 100)
    expect(() => db.create("one", 101)).toThrow("already")
    db.create("two", 101)
    expect(() => db.create("three", 102)).toThrow("capacity")
    db.finish(first.id, "quiet")
    for (let i = 0; i < 4; i++) db.finish(db.create("one", 110 + i).id, "quiet")
    expect(() => db.create("one", 120)).toThrow("capacity")
  })
  it("recovers abandoned attempts after the deadline without awarding more points", () => {
    const db = store()
    const run = db.create("owner", 100)
    db.increment(run.id, 101)
    expect(db.latest("owner", 100 + CHALLENGE_DURATION_MS)).toMatchObject({ score: 1, status: "timeout" })
    expect(db.increment(run.id, 101 + CHALLENGE_DURATION_MS).score).toBe(1)
    expect(db.create("owner", 102 + CHALLENGE_DURATION_MS).id).not.toBe(run.id)
  })
  it("shares admission and scores across connections to the same volume", () => {
    const folder = mkdtempSync(join(tmpdir(), "room-challenge-concurrency-"))
    const path = join(folder, "scores.sqlite")
    const first = new ChallengeStore(path)
    const second = new ChallengeStore(path)
    try {
      const run = first.create("owner", 100)
      expect(() => second.create("owner", 101)).toThrow("already")
      second.increment(run.id, 101)
      expect(first.get(run.id).score).toBe(1)
      first.finish(run.id, "quiet")
      second.publish(run.id, "owner", "Ada", 102)
      first.publish(run.id, "owner", "Duplicate", 103)
      expect(second.scoreboard()).toHaveLength(1)
    } finally { first.close(); second.close(); rmSync(folder, { recursive: true, force: true }) }
  })
  it("orders by score then publication, and persists across reopened connections", () => {
    const folder = mkdtempSync(join(tmpdir(), "room-challenge-test-"))
    const path = join(folder, "scores.sqlite")
    try {
      const db = new ChallengeStore(path)
      for (const [name, points] of [["First", 3], ["Second", 8], ["Third", 8]] as const) {
        const run = db.create(name, 100)
        for (let i = 0; i < points; i++) db.increment(run.id, 101)
        db.finish(run.id, "quiet")
        db.publish(run.id, name, name, name === "Third" ? 103 : 102)
      }
      db.close()
      const reopened = new ChallengeStore(path)
      expect(reopened.scoreboard().map((entry) => entry.name)).toEqual(["Second", "Third", "First"])
      reopened.close()
    } finally { rmSync(folder, { recursive: true, force: true }) }
  })
  it("places an attempt in the ranking's own order, below the visible board too", () => {
    const db = store()
    const ids: string[] = []
    // An hour apart, so the hourly admission caps never stand in for the test.
    const when = (index: number) => 100 + index * 3_700_000
    for (let index = 0; index < 52; index++) {
      const run = db.create(`owner-${index}`, when(index))
      // One point each: the tie-break is publication order and nothing else.
      db.increment(run.id, when(index))
      db.finish(run.id, "quiet")
      db.publish(run.id, `owner-${index}`, `Player ${index}`, when(index))
      ids.push(run.id)
    }
    expect(db.standing(ids[0])).toEqual({ rank: 1, total: 52 })
    // The board stops at fifty. A place does not.
    expect(db.scoreboard()).toHaveLength(50)
    expect(db.standing(ids[51])).toEqual({ rank: 52, total: 52 })
    const late = db.create("late", when(60))
    for (let index = 0; index < 5; index++) db.increment(late.id, when(60))
    db.finish(late.id, "quiet")
    db.publish(late.id, "late", "Late", when(60))
    expect(db.standing(late.id)).toEqual({ rank: 1, total: 53 })
    expect(db.standing(ids[0])).toEqual({ rank: 2, total: 53 })
    // Nothing to place until it is on the board.
    expect(db.standing(db.create("nobody", when(70)).id)).toBeNull()
    expect(db.standing("missing")).toBeNull()
  })
  it("lifts the ceiling off a board that was written with one", () => {
    const folder = mkdtempSync(join(tmpdir(), "room-challenge-legacy-"))
    const path = join(folder, "scores.sqlite")
    try {
      // The table exactly as the twenty-reply game created it, holding a win.
      const legacy = new DatabaseSync(path)
      legacy.exec(`
        CREATE TABLE challenge_runs (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 20),
          status TEXT NOT NULL DEFAULT 'running', entry_id TEXT UNIQUE, name TEXT, submitted_at INTEGER
        );
        INSERT INTO challenge_runs (id, owner, created_at, expires_at, score, status, entry_id, name, submitted_at)
          VALUES ('old-win', 'owner', 100, 200, 20, 'won', 'old-entry', 'Ada', 150);
        INSERT INTO challenge_runs (id, owner, created_at, expires_at, score, status)
          VALUES ('old-quiet', 'other', 100, 200, 4, 'quiet');
      `)
      legacy.close()
      const db = store(path)
      // The score and its place survive; the title it carried does not.
      expect(db.get("old-win")).toEqual({ id: "old-win", score: 20, status: "quiet", submitted: true })
      expect(db.scoreboard()).toEqual([{ id: "old-entry", name: "Ada", score: 20, rank: 1 }])
      expect(db.standing("old-win")).toEqual({ rank: 1, total: 1 })
      expect(db.get("old-quiet")).toMatchObject({ score: 4, status: "quiet" })
      // And the ceiling is gone rather than merely unenforced above.
      const fresh = db.create("owner", 1000)
      for (let index = 0; index < 21; index++) db.increment(fresh.id, 1000)
      expect(db.get(fresh.id).score).toBe(21)
      // Reopening does not migrate a second time or lose anything to it.
      const again = store(path)
      expect(again.scoreboard()).toHaveLength(1)
      expect(again.get(fresh.id).score).toBe(21)
    } finally { rmSync(folder, { recursive: true, force: true }) }
  })
  it("stores only a hash of the secret browser token", () => {
    expect(challengeOwner("token")).toMatch(/^[a-f0-9]{64}$/)
    expect(challengeOwner("token")).not.toBe(challengeOwner("other"))
  })
})

describe("a place on the board", () => {
  it("accepts two whole numbers, the first inside the second", () => {
    expect(isStanding({ rank: 1, total: 1 })).toBe(true)
    expect(isStanding({ rank: 7, total: 61 })).toBe(true)
  })
  // What reaches the result dialog decides what it can render. Anything else is
  // a heading with no score under it, so it is not a place at all.
  it.each([null, {}, { rank: 0, total: 3 }, { rank: 4, total: 3 }, { rank: 1.5, total: 3 }, { rank: "1", total: 3 }, { rank: 1 }])
    ("rejects %s", (value) => expect(isStanding(value)).toBe(false))
})

describe("a score in words", () => {
  // Said by the counter, the result and every row of the board, so it is said
  // in one place.
  it.each([[0, "0 replies"], [1, "1 reply"], [2, "2 replies"], [41, "41 replies"]])("calls %s %s", (score, said) => {
    expect(replies(score)).toBe(said)
  })
})

describe("public nicknames", () => {
  it.each(["Ana", "José", "小明", "O’Connor", "Fabri 24"])("accepts %s", (name) => expect(publicName(name)).toBe(name))
  it.each(["", "  ", "---", "<script>", "a\nb", "a\u202Eb", "a\u200Bb", "x".repeat(25), 42])("rejects %s", (name) => expect(publicName(name)).toBeNull())
  it("normalizes surrounding/repeated spaces", () => expect(publicName("  Ada   Lovelace  ")).toBe("Ada Lovelace"))
})
