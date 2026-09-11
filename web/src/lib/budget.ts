import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { stateRoot } from "./state"

/**
 * What this account is willing to spend on being heard, per month.
 *
 * The rate limiter answers "how fast", which is the wrong question for a demo
 * that is linked in a README and left running. A ceiling of two voice requests
 * a second is an entirely reasonable burst and an entirely unreasonable month:
 * nothing in this project knew how much it had spent since the first of the
 * month, and nothing could have told you when a bored visitor with a script
 * drained the key overnight.
 *
 * So the two things that cost money count themselves. Characters, because that
 * is what synthesis is billed on, and transcription sessions, because that is
 * what a minted token becomes. Both reset when the month does.
 *
 * This is a SPEND guard, not a security boundary — it fails open. A storage
 * fault silences nothing: the rate limiter is the hard bound, and a room that
 * went quiet because a database file was unwritable would be a worse failure
 * than the one this prevents.
 */

export type Spend = { ok: boolean; used: number; limit: number }

/** Zero means no ceiling. Unreadable means the default, because a typo in an
 *  environment variable must not read as "unlimited". */
export function ceiling(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === "") return fallback
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * The defaults: roughly a thousand spoken replies and three hundred recordings
 * in a month. Generous for the people this demo is actually for, and a fraction
 * of what an unattended key can lose in an afternoon.
 */
export const MONTHLY_CHARACTERS = "SPEECH_MONTHLY_CHARACTERS"
export const MONTHLY_SESSIONS = "SPEECH_MONTHLY_SESSIONS"
const DEFAULT_CHARACTERS = 200_000
const DEFAULT_SESSIONS = 300

/** UTC, so the month turns over at one moment for everybody. */
export function monthOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
}

export class SpeechBudget {
  readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS speech_spend (
        month TEXT PRIMARY KEY,
        characters INTEGER NOT NULL DEFAULT 0,
        sessions INTEGER NOT NULL DEFAULT 0
      );
    `)
  }

  /**
   * Take from this month's allowance, or refuse.
   *
   * One immediate transaction, so two requests arriving together cannot both
   * read the same remaining balance and both spend it. Refusing costs nothing:
   * the row is left exactly as it was.
   */
  private take(column: "characters" | "sessions", amount: number, limit: number, now: Date): Spend {
    const month = monthOf(now)
    if (limit <= 0) return { ok: true, used: 0, limit: 0 }
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare("INSERT OR IGNORE INTO speech_spend (month) VALUES (?)").run(month)
      const row = this.db.prepare(`SELECT ${column} AS used FROM speech_spend WHERE month = ?`).get(month) as { used: number }
      const used = Number(row?.used ?? 0)
      if (used + amount > limit) {
        this.db.exec("ROLLBACK")
        return { ok: false, used, limit }
      }
      this.db.prepare(`UPDATE speech_spend SET ${column} = ${column} + ? WHERE month = ?`).run(amount, month)
      this.db.exec("COMMIT")
      return { ok: true, used: used + amount, limit }
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }

  /** Characters about to be synthesised. Counted as submitted, which is what
   *  the invoice counts. */
  characters(amount: number, now = new Date()): Spend {
    return this.take("characters", amount, ceiling(MONTHLY_CHARACTERS, DEFAULT_CHARACTERS), now)
  }

  /** One transcription session, which is what a minted token becomes. */
  session(now = new Date()): Spend {
    return this.take("sessions", 1, ceiling(MONTHLY_SESSIONS, DEFAULT_SESSIONS), now)
  }

  /** What has been spent this month, for anybody who wants to look. */
  used(now = new Date()): { characters: number; sessions: number } {
    const row = this.db.prepare("SELECT characters, sessions FROM speech_spend WHERE month = ?").get(monthOf(now)) as
      { characters: number; sessions: number } | undefined
    return { characters: Number(row?.characters ?? 0), sessions: Number(row?.sessions ?? 0) }
  }

  close() { this.db.close() }
}

let budget: SpeechBudget | undefined | null
function open(): SpeechBudget | null {
  if (budget !== undefined) return budget
  try {
    const folder = join(stateRoot(), ".hermes", "speech")
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    budget = new SpeechBudget(join(folder, "budget.sqlite"))
  } catch {
    // Reported once, by the route that asked. See the header: this guard costs
    // the account money when it works and costs the room nothing when it does not.
    budget = null
  }
  return budget
}

/** Forget the open database, so a test can point at a different one. */
export function forgetBudget() {
  try { budget?.close() } catch { /* Already closed. */ }
  budget = undefined
}

function spend(take: (db: SpeechBudget) => Spend): Spend {
  const db = open()
  if (!db) return { ok: true, used: 0, limit: 0 }
  try { return take(db) } catch { return { ok: true, used: 0, limit: 0 } }
}

export const spendCharacters = (amount: number): Spend => spend((db) => db.characters(amount))
export const spendSession = (): Spend => spend((db) => db.session())
