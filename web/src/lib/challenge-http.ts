import { randomBytes } from "node:crypto"
import { cookies } from "next/headers"
import { ChallengeError, challengeOwner } from "./challenge-store"

const COOKIE = "room-challenger"
export const privateHeaders = { "Cache-Control": "no-store" }

export async function owner(create = false, secure = true): Promise<string | null> {
  const jar = await cookies()
  let token = jar.get(COOKIE)?.value
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    if (!create) return null
    token = randomBytes(32).toString("hex")
    jar.set(COOKIE, token, { httpOnly: true, sameSite: "strict", secure, path: "/", maxAge: 30 * 86_400 })
  }
  return challengeOwner(token)
}

/** Same-origin writes, bounded actual bytes, and no trusted browser-supplied score. */
export async function challengeBody(request: Request): Promise<Record<string, unknown>> {
  const origin = request.headers.get("origin")
  const host = request.headers.get("host") ?? new URL(request.url).host
  if (origin) {
    try { if (new URL(origin).host !== host) throw new Error() }
    catch { throw new ChallengeError(403, "Use this site's challenge page.") }
  }
  const site = request.headers.get("sec-fetch-site")
  if (site && site !== "same-origin" && site !== "none") throw new ChallengeError(403, "Use this site's challenge page.")
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ChallengeError(415, "Expected JSON.")
  const reader = request.body?.getReader()
  if (!reader) throw new ChallengeError(400, "Missing request body.")
  const decoder = new TextDecoder()
  let body = ""
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) { await reader.cancel(); throw new ChallengeError(413, "Request too large.") }
      body += decoder.decode(value, { stream: true })
    }
    const parsed = JSON.parse(body + decoder.decode())
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch (error) {
    if (error instanceof ChallengeError) throw error
    throw new ChallengeError(400, "Invalid JSON.")
  } finally { reader.releaseLock() }
}

export function challengeFailure(error: unknown) {
  const known = error instanceof ChallengeError
  if (!known) console.error(JSON.stringify({ event: "challenge.storage_error", version: 1 }))
  return Response.json({ error: known ? error.message : "The challenge is unavailable. Please try again." }, {
    status: known ? error.status : 503,
    headers: { ...privateHeaders, ...(known && error.status === 429 ? { "Retry-After": "60" } : {}) },
  })
}
