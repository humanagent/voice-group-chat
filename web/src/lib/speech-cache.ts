import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { stateRoot } from "./state"

/**
 * The same line, said again, for free.
 *
 * A reply is synthesised once and then heard as many times as somebody reloads
 * the page, replays the round or scrolls back through the transcript — and the
 * account was charged for every one of them, because the route answered
 * `no-store` and there was nothing behind it. The audio for a given voice,
 * model, language and string never changes, so the second request for it is a
 * file read.
 *
 * Content-addressed: the key is the hash of everything that decides what comes
 * back, so a voice change, a model change or an edited word is a different clip
 * rather than a stale one. The text is hashed and never stored, and the clips
 * live in the same gitignored state directory the agents already write their
 * own audio into.
 *
 * Bounded by count rather than age: five hundred clips is a long conversation,
 * and the oldest go when the room outgrows it. An unreadable or unwritable
 * cache costs nothing, because every path here falls back to synthesising.
 */

export type Clip = { audio: string; chars: string[]; starts: number[] }

/** Clips to keep. Past this the oldest are dropped on the next write. */
const KEEP = 500

const off = () => (process.env.SPEECH_CACHE ?? "").trim() === "0"

function folder(): string {
  const dir = join(stateRoot(), ".hermes", "speech", "clips")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Everything that decides what comes back, and nothing that does not. */
export function clipKey(parts: { voice: string; model: string; language: string | null; format: string; text: string }): string {
  const statement = [parts.voice, parts.model, parts.language ?? "", parts.format, parts.text].join(" ")
  return createHash("sha256").update(statement).digest("hex")
}

export function readClip(key: string): Clip | null {
  if (off()) return null
  try {
    const clip = JSON.parse(readFileSync(join(folder(), `${key}.json`), "utf8")) as Clip
    // A half-written file from a killed process is not a clip. Checked here
    // rather than trusted, because the alternative is a player handed nothing.
    if (typeof clip?.audio !== "string" || !clip.audio || !Array.isArray(clip.chars) || !Array.isArray(clip.starts)) return null
    return clip
  } catch {
    return null
  }
}

export function writeClip(key: string, clip: Clip): void {
  if (off()) return
  try {
    const dir = folder()
    // Written beside and renamed, so a reader never opens half a clip.
    const temporary = join(dir, `${key}.${process.pid}.writing`)
    writeFileSync(temporary, JSON.stringify(clip), { mode: 0o600 })
    renameSync(temporary, join(dir, `${key}.json`))
    prune(dir)
  } catch {
    // Out of disk, a read-only volume, no state directory. The clip was already
    // synthesised and returned; this was only the part that would have saved
    // the next one.
  }
}

/** Oldest first, down to the limit. Runs on a write, which in a conversation is
 *  a few times a minute, and a directory listing at that rate is not a cost. */
function prune(dir: string) {
  const clips = readdirSync(dir).filter((name) => name.endsWith(".json"))
  if (clips.length <= KEEP) return
  const byAge = clips
    .map((name) => {
      const path = join(dir, name)
      try { return { path, at: statSync(path).mtimeMs } } catch { return null }
    })
    .filter((entry): entry is { path: string; at: number } => !!entry)
    .sort((a, b) => a.at - b.at)
  for (const { path } of byAge.slice(0, byAge.length - KEEP)) {
    try { unlinkSync(path) } catch { /* Somebody else got there first. */ }
  }
}
