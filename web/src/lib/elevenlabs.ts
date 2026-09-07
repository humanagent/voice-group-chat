import { readFileSync } from "node:fs"
import { join } from "node:path"

import { stateRoot } from "@/lib/state"

/**
 * The ElevenLabs key, from the environment or from the project's Hermes home.
 *
 * The same two places the Python looks, and for the same reason: the key was
 * put in `.hermes/.env` when the group was provisioned, and asking somebody to
 * copy it into a second file so the browser can find it is a step that gets
 * skipped once and then debugged for an hour. Deployed there is no such file,
 * so the environment wins wherever it is set.
 */
export function key(): string {
  const fromEnv = process.env.ELEVENLABS_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const env = readFileSync(join(stateRoot(), ".hermes", ".env"), "utf8")
    for (const line of env.split("\n")) {
      const [name, ...rest] = line.split("=")
      if (name.trim() === "ELEVENLABS_API_KEY") return rest.join("=").trim()
    }
  } catch {
    // No home and no key. The caller reads that as "speech is off".
  }
  return ""
}

/**
 * What speaks the replies.
 *
 * A copy of `TTS_MODEL` in `src/defaults.py`, because a Next.js route cannot
 * read a Python module. The runtime picks it for a measured reason — flash is
 * the one built for live conversation — and a browser quietly synthesising with
 * something else would be slower or dearer for reasons nobody could see.
 *
 * A test reads that file and fails if the two ever drift. See
 * `tests/web/voices.test.ts`.
 */
export const TTS_MODEL = "eleven_flash_v2_5"
