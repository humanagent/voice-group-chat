import { publicName } from "./challenge"

/**
 * Who is at the keyboard.
 *
 * The room had exactly one human in it and called them `you` — in the title, in
 * the transcript, and in the `you:` prefix every agent read. That is a label,
 * not a name, and it is the reason an agent answering a question could name Steve
 * and Pepe but never the person it was actually talking to.
 *
 * So the person names themselves once, by typing it into the title, and that one
 * name is who they are everywhere: the room is theirs, the agents call them by
 * it, and the scoreboard publishes it without asking a second time.
 *
 * Kept per browser, because the next person to sit down is a different player.
 * Fabri's room becomes Alf's room by typing Alf.
 */

export const PLAYER_KEY = "room.player"

/**
 * What an unnamed person is called on the wire.
 *
 * Still recognised, never written any more. Rooms opened before names existed
 * are full of `you:` lines, and a transcript that stopped reading them as the
 * reader's own would flip every past message to the wrong side of the room.
 */
export const UNNAMED = "you"

/** The room's own machinery, which speaks the opening roster and is not a person. */
const MACHINERY = "System"

/**
 * A name this room can actually use, or null.
 *
 * `publicName` already enforces what a speaker prefix needs — 1–24 characters,
 * no colon, no newline, no markup — because a scoreboard nickname and a line in
 * a transcript have the same hostile inputs. The reservation on top of it is not
 * etiquette: every line is delivered to `audienceFor(group, speaker)`, which
 * hands the line to everyone *except* the speaker, so a person calling
 * themselves Steve would be the one member of the room Steve never hears.
 */
export function playerName(value: unknown, agents: readonly string[] = []): string | null {
  const name = publicName(value)
  if (!name) return null
  const taken = [...agents, MACHINERY, UNNAMED].map((one) => one.toLowerCase())
  return taken.includes(name.toLowerCase()) ? null : name
}

/** Why a name was refused, in words a person can act on. */
export function refusal(value: string, agents: readonly string[] = []): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  // Named back the way the room spells it, not the way it was typed: "steve is
  // already in the room" reads like a different Steve.
  const taken = agents.find((agent) => agent.toLowerCase() === trimmed.toLowerCase())
  if (taken) return `${taken} is already in the room.`
  return playerName(trimmed, agents) ? null : "Letters, numbers and spaces."
}

/**
 * The stored name, or "" when nobody has claimed the room.
 *
 * Reading storage throws outright in some browsers (private windows, site data
 * blocked), and an unreadable name must cost the room nothing: it opens exactly
 * as it did before names existed.
 */
export function readPlayer(): string {
  try { return publicName(localStorage.getItem(PLAYER_KEY)) ?? "" }
  catch { return "" }
}

/** Persist the name, or forget it when cleared. Never throws. */
export function writePlayer(name: string): void {
  try {
    if (name) localStorage.setItem(PLAYER_KEY, name)
    else localStorage.removeItem(PLAYER_KEY)
  } catch { /* The name still holds for this session; storage is the convenience. */ }
}

/** What to put in front of a line the person sends. */
export function speakerFor(name: string): string {
  return name || UNNAMED
}

/**
 * Whether a line in the transcript is the reader's own.
 *
 * Their name, or the `you` every line carried before names existed — so a room
 * full of old messages does not flip to the far side the moment somebody claims
 * it. Case-insensitive, because a person who types `alf` on Tuesday and `Alf` on
 * Wednesday is the same person in the same seat.
 */
export function isMine(speaker: string, player: string): boolean {
  if (speaker === UNNAMED) return true
  return !!player && speaker.toLowerCase() === player.toLowerCase()
}
