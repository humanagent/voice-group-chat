import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChallengeStore, challengeOwner } from "@/lib/challenge-store"
import { CHALLENGE_DURATION_MS, publicName } from "@/lib/challenge"

const stores: ChallengeStore[] = []
function store(path = ":memory:") { const db = new ChallengeStore(path); stores.push(db); return db }
afterEach(() => { for (const db of stores.splice(0)) db.close() })

describe("server-owned challenge scores", () => {
  it("starts at zero, awards exactly 20 and cannot increment or downgrade a win", () => {
    const db = store()
    const run = db.create("owner", 100)
    expect(run.score).toBe(0)
    for (let index = 1; index <= 30; index++) expect(db.increment(run.id, 101).score).toBe(Math.min(index, 20))
    expect(db.finish(run.id, "stopped")).toMatchObject({ score: 20, status: "won" })
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
    expect(db.scoreboard()).toEqual([{ id: expect.any(String), name: "Ada", score: 1, rank: 1, won: false }])
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
  it("stores only a hash of the secret browser token", () => {
    expect(challengeOwner("token")).toMatch(/^[a-f0-9]{64}$/)
    expect(challengeOwner("token")).not.toBe(challengeOwner("other"))
  })
})

describe("public nicknames", () => {
  it.each(["Ana", "José", "小明", "O’Connor", "Fabri 24"])("accepts %s", (name) => expect(publicName(name)).toBe(name))
  it.each(["", "  ", "---", "<script>", "a\nb", "a\u202Eb", "a\u200Bb", "x".repeat(25), 42])("rejects %s", (name) => expect(publicName(name)).toBeNull())
  it("normalizes surrounding/repeated spaces", () => expect(publicName("  Ada   Lovelace  ")).toBe("Ada Lovelace"))
})
