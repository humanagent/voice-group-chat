import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { stateRoot } from "@/lib/state"

/**
 * The backstories, from `personas/` at the repo root.
 *
 * Deliberately NOT in `context/`. Everything in that folder is loaded into
 * every agent on every turn — that is the shared contract, the thing they all
 * agree on. A persona is the opposite: one agent's alone, and the room is only
 * interesting because the others cannot read it.
 */
const FOLDER = join(process.cwd(), "..", "personas")

/**
 * Who drew what, once.
 *
 * The cast used to be dealt every time a room was opened, which was fine when
 * opening a room meant making a new one. There is one room now and a button
 * that empties it, and an agent who was in support before you pressed it and
 * runs security after is not a cleared context — it is a different person
 * wearing the same name. So the deal is written down the first time and read
 * back forever after.
 *
 * Beside the group's own state, because that is what it is: not source, not
 * configuration, and not something a fresh clone should inherit.
 */
const CAST = () => join(stateRoot(), ".hermes", "cast.json")

function files(): string[] {
  try {
    return readdirSync(FOLDER)
      .filter((f) => f.endsWith(".md"))
      .sort()
  } catch {
    // No folder is not an error: the room works exactly as it did before,
    // with agents who are nobody in particular.
    return []
  }
}

/** The cast on disk, kept only where it still names a persona that exists. */
function written(): Record<string, string> {
  try {
    const saved = JSON.parse(readFileSync(CAST(), "utf8")) as Record<string, string>
    const known = new Set(files())
    return Object.fromEntries(Object.entries(saved).filter(([, f]) => known.has(f)))
  } catch {
    return {}
  }
}

/**
 * One persona each, drawn at random the first time and stable after it.
 *
 * Fewer personas than agents is survivable — whoever draws nothing is simply
 * itself — so this returns a slot per agent rather than refusing.
 */
export function cast(names: string[]): (string | null)[] {
  const deck = files()
  if (!deck.length) return names.map(() => null)

  const held = written()
  const taken = new Set(Object.values(held))
  const free = deck.filter((f) => !taken.has(f))
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[free[i], free[j]] = [free[j], free[i]]
  }

  let changed = false
  for (const name of names) {
    if (held[name]) continue
    const drawn = free.pop()
    if (!drawn) break
    held[name] = drawn
    changed = true
  }
  if (changed && existsSync(join(stateRoot(), ".hermes"))) {
    try {
      writeFileSync(CAST(), JSON.stringify(held, null, 2) + "\n")
    } catch {
      // An unwritable home costs the group its memory of who is who, not its
      // ability to open the room.
    }
  }

  return names.map((n) => {
    const file = held[n]
    if (!file) return null
    try {
      return readFileSync(join(FOLDER, file), "utf8").trim() || null
    } catch {
      return null
    }
  })
}

/**
 * A persona, framed so it reads as an identity rather than as a document.
 *
 * It arrives inside the introduction the agent already gets, so opening the
 * room still costs one turn per agent: a second System message would double the
 * wait for the one screen that has nothing to show yet.
 */
export function briefing(persona: string): string {
  return (
    "This is who you are. It is yours alone — the others in this room have " +
    "been given their own and cannot see this one, so never quote it, never " +
    "describe it as a briefing, and never announce your role unless somebody " +
    "asks. Simply be this person.\n\n" +
    persona
  )
}
