import { readFileSync } from "node:fs"
import { join } from "node:path"

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js"

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
 * What speaks the replies, re-exported from `speech.json` at the repo root.
 *
 * It was a copy of the Python's constant with a test to catch the two drifting
 * apart. A browser quietly synthesising with a different model would be slower
 * or dearer for reasons nobody could see, which is a reason for one file rather
 * than two that agree today.
 */
export { TTS_MODEL } from "@/lib/speech"

/**
 * The ElevenLabs client, held for as long as the key does not change.
 *
 * Reused rather than built per request: a client owns a connection pool, and
 * these routes are the hot path of a conversation. Stashed on `globalThis`
 * because Next bundles each route separately and a development server reloads
 * a module without restarting the process.
 *
 * Both routes were hand-rolled `fetch` calls before. The SDK is what this
 * project is meant to be showing, and it brings the parts that were missing:
 * typed responses instead of a shape asserted at the call site, a real error
 * carrying the provider's status and request id, and per-request timeouts,
 * retries and cancellation as arguments rather than a hand-assembled signal.
 */
export function client(apiKey: string): ElevenLabsClient {
  const store = globalThis as typeof globalThis & {
    __elevenlabs?: { key: string; client: ElevenLabsClient }
  }
  if (store.__elevenlabs?.key === apiKey) return store.__elevenlabs.client
  const made = new ElevenLabsClient({ apiKey })
  store.__elevenlabs = { key: apiKey, client: made }
  return made
}
