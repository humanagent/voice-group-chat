import { createHash, randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CHALLENGE_DURATION_MS, CHALLENGE_TARGET, type ChallengeRun, type ChallengeStatus, type ScoreEntry, type Standing } from "./challenge"
import { stateRoot } from "./state"

type Row = { id: string; owner: string; score: number; status: ChallengeStatus; entry_id: string | null }
export class ChallengeError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

/** One SQLite file on the existing Railway volume. No prompts or transcripts. */
export class ChallengeStore {
  readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS challenge_runs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 20),
        status TEXT NOT NULL DEFAULT 'running', entry_id TEXT UNIQUE, name TEXT, submitted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS challenge_owner ON challenge_runs(owner, created_at DESC);
      CREATE INDEX IF NOT EXISTS challenge_created ON challenge_runs(created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS challenge_active_owner ON challenge_runs(owner) WHERE status = 'running';
      CREATE INDEX IF NOT EXISTS challenge_scores ON challenge_runs(score DESC, submitted_at, entry_id) WHERE entry_id IS NOT NULL;
    `)
  }
  private view(row: Row): ChallengeRun {
    return { id: row.id, score: row.score, target: CHALLENGE_TARGET, status: row.status, submitted: !!row.entry_id }
  }
  private expire(now: number) {
    this.db.prepare("UPDATE challenge_runs SET status = 'timeout' WHERE status = 'running' AND expires_at <= ?").run(now)
  }
  create(owner: string, now = Date.now()): ChallengeRun {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.expire(now)
      this.db.prepare("DELETE FROM challenge_runs WHERE entry_id IS NULL AND created_at < ?").run(now - 7 * 86_400_000)
      if (this.db.prepare("SELECT 1 FROM challenge_runs WHERE owner = ? AND status = 'running'").get(owner)) {
        throw new ChallengeError(409, "You already have a challenge running. Wait for it to finish.")
      }
      const count = (sql: string, ...params: (number | string)[]) => Number(this.db.prepare(sql).get(...params)?.n ?? 0)
      if (count("SELECT COUNT(*) AS n FROM challenge_runs WHERE status = 'running'") >= 2 ||
        count("SELECT COUNT(*) AS n FROM challenge_runs WHERE created_at > ?", now - 3_600_000) >= 30 ||
        count("SELECT COUNT(*) AS n FROM challenge_runs WHERE owner = ? AND created_at > ?", owner, now - 3_600_000) >= 5) {
        throw new ChallengeError(429, "The challenge is at capacity. Please try again later.")
      }
      const id = randomUUID()
      this.db.prepare("INSERT INTO challenge_runs (id, owner, created_at, expires_at) VALUES (?, ?, ?, ?)").run(id, owner, now, now + CHALLENGE_DURATION_MS)
      this.db.exec("COMMIT")
      return { id, score: 0, target: CHALLENGE_TARGET, status: "running", submitted: false }
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  latest(owner: string, now = Date.now()): ChallengeRun | null {
    this.expire(now)
    const row = this.db.prepare("SELECT * FROM challenge_runs WHERE owner = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(owner) as Row | undefined
    return row ? this.view(row) : null
  }
  get(id: string): ChallengeRun {
    const row = this.db.prepare("SELECT * FROM challenge_runs WHERE id = ?").get(id) as Row | undefined
    if (!row) throw new ChallengeError(404, "Challenge not found.")
    return this.view(row)
  }
  /** Called only by the runner after an actual spoken agent reply. */
  increment(id: string, now = Date.now()): ChallengeRun {
    this.expire(now)
    this.db.prepare(`UPDATE challenge_runs SET score = score + 1,
      status = CASE WHEN score + 1 = ? THEN 'won' ELSE 'running' END
      WHERE id = ? AND status = 'running' AND score < ?`).run(CHALLENGE_TARGET, id, CHALLENGE_TARGET)
    return this.get(id)
  }
  finish(id: string, status: Exclude<ChallengeStatus, "running" | "won">): ChallengeRun {
    this.db.prepare("UPDATE challenge_runs SET status = ? WHERE id = ? AND status = 'running'").run(status, id)
    return this.get(id)
  }
  publish(id: string, owner: string, name: string, now = Date.now()): ChallengeRun {
    this.expire(now)
    const row = this.db.prepare("SELECT * FROM challenge_runs WHERE id = ? AND owner = ?").get(id, owner) as Row | undefined
    if (!row) throw new ChallengeError(404, "Challenge not found.")
    if (row.status === "running") throw new ChallengeError(409, "Finish the challenge before publishing.")
    // Retries cannot create duplicates or rename an already published result.
    this.db.prepare("UPDATE challenge_runs SET entry_id = ?, name = ?, submitted_at = ? WHERE id = ? AND entry_id IS NULL").run(randomUUID(), name, now, id)
    return this.get(id)
  }
  /**
   * Where one published attempt sits on the board.
   *
   * Counted rather than looked up in the list, because the list stops at fifty
   * and a place has to exist below that. The comparison is the ranking's own
   * ORDER BY turned inside out — score, then who published first, then the
   * entry id — so the number here and the row in the list can never disagree.
   * Changing one ordering means changing both in the same edit.
   */
  standing(id: string): Standing | null {
    const row = this.db.prepare("SELECT entry_id, score, submitted_at FROM challenge_runs WHERE id = ?").get(id) as
      { entry_id: string | null; score: number; submitted_at: number | null } | undefined
    if (!row?.entry_id) return null
    const ahead = this.db.prepare(`SELECT COUNT(*) AS n FROM challenge_runs WHERE entry_id IS NOT NULL
      AND (score > ? OR (score = ? AND (submitted_at < ? OR (submitted_at = ? AND entry_id < ?))))`)
      .get(row.score, row.score, row.submitted_at, row.submitted_at, row.entry_id)
    const board = this.db.prepare("SELECT COUNT(*) AS n FROM challenge_runs WHERE entry_id IS NOT NULL").get()
    return { rank: Number(ahead?.n ?? 0) + 1, total: Number(board?.n ?? 0) }
  }
  scoreboard(): ScoreEntry[] {
    return this.db.prepare(`SELECT entry_id AS id, name, score FROM challenge_runs
      WHERE entry_id IS NOT NULL ORDER BY score DESC, submitted_at ASC, entry_id ASC LIMIT 50`).all()
      .map((row, index) => ({ id: String(row.id), name: String(row.name), score: Number(row.score), won: row.score === CHALLENGE_TARGET, rank: index + 1 }))
  }
  close() { this.db.close() }
}

export function challengeOwner(token: string) { return createHash("sha256").update(token).digest("hex") }

let store: ChallengeStore | undefined
export function challengeStore(): ChallengeStore {
  if (!store) {
    const folder = join(stateRoot(), ".hermes", "challenge")
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    store = new ChallengeStore(join(folder, "scoreboard.sqlite"))
  }
  return store
}
