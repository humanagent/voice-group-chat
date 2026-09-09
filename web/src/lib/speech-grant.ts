import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Proof that the room actually said this.
 *
 * The synthesis route used to take a name and a string of text and read out
 * whatever it was given. That is an open text-to-speech proxy on somebody
 * else's key: the length cap and the rate limit below bound what it costs, but
 * neither of them makes it stop being one. What closes it is that the server
 * only ever speaks its OWN words.
 *
 * So a reply is signed at the moment the room emits it, the browser hands the
 * signature back with the request to hear it, and the route synthesises only
 * what verifies. No store and no round trip: the grant travels with the line
 * it belongs to, which is the only place it was ever needed.
 *
 * A grant is not a session and not a capability. It says one thing — this
 * exact agent said this exact text — and it is worth replaying only for as
 * long as the same text would be worth hearing again.
 */

const SECRET = "SPEECH_SIGNING_SECRET"

/**
 * The key, from the environment or minted for this process.
 *
 * Configured, grants survive a restart and a second replica would honour the
 * first one's. Unconfigured, the process makes its own: grants are spent within
 * seconds of being issued, so a restart invalidating them costs at most the
 * clip somebody was already listening to. What it never does is fall back to a
 * fixed default, which is a shared secret that is not secret.
 */
function secret(): Buffer {
  const store = globalThis as typeof globalThis & { __speechSecret?: Buffer }
  if (store.__speechSecret) return store.__speechSecret
  const configured = process.env[SECRET]?.trim()
  store.__speechSecret = configured ? Buffer.from(configured, "utf8") : randomBytes(32)
  return store.__speechSecret
}

/** The signed statement. Length-prefixed so an agent named `A` saying `B:C`
 *  and an agent named `A:B` saying `C` cannot produce the same bytes. */
function statement(agent: string, text: string): string {
  return `${agent.length}:${agent}:${text.length}:${text}`
}

export function grantFor(agent: string, text: string): string {
  return createHmac("sha256", secret()).update(statement(agent, text)).digest("base64url")
}

/** Whether this grant was issued by this room for these exact words. */
export function grantAllows(agent: string, text: string, grant: string | null): boolean {
  if (!grant) return false
  const expected = Buffer.from(grantFor(agent, text), "utf8")
  const offered = Buffer.from(grant, "utf8")
  // Compared over equal lengths only, because `timingSafeEqual` throws rather
  // than returning false when they differ, and a thrown comparison is a leak
  // dressed as an error.
  return expected.length === offered.length && timingSafeEqual(expected, offered)
}
