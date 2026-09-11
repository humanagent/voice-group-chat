import { createReadStream, statSync } from "node:fs"
import { realpathSync } from "node:fs"
import { join, sep } from "node:path"
import { Readable } from "node:stream"

import { agents } from "@/lib/agents"
import { caller, limiter } from "@/lib/rate-limit"
import { sameOrigin } from "@/lib/same-origin"
import { stateRoot } from "@/lib/state"

export const dynamic = "force-dynamic"

const PLAYABLE: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
}

/**
 * The directories a clip is allowed to come from.
 *
 * Each agent synthesises into its own Hermes home, so the homes ARE the
 * allow-list — this is not "read a file the client named", it is "read a clip
 * out of the four places that make clips". Resolved through symlinks before
 * comparing, because `..` and a link are the same trick from the server's side.
 */
function homes(): string[] {
  const root = stateRoot()
  const homes = [".hermes", ...agents().map((a) => `.hermes-${a.name.toLowerCase()}`)]
  return homes
    .map((home) => join(root, home, "cache", "audio"))
    .flatMap((dir) => {
      try {
        return [realpathSync(dir)]
      } catch {
        return []
      }
    })
}

/** The same shape its siblings use. Nothing here reaches a provider, so this
 *  is about the disk and the bandwidth rather than the account. */
const clipLimit = () => limiter("clips", { perMinute: 60, burst: 30 }, { perMinute: 240, burst: 120 })

/**
 * Serve one spoken reply.
 *
 * A reply arrives carrying the path of a file on the machine that made it, so
 * locally the browser can hear it and deployed it cannot — the clip is on the
 * agent's disk, not the web server's. Rather than pretend otherwise this
 * returns 404 there, and the room falls back to marking the line as spoken.
 */
export async function GET(request: Request) {
  // The two checks every other route in this room makes. This one reads files
  // rather than spending money, which is why it went without them for so long
  // and is not a reason to be the one door left open.
  if (!sameOrigin(request)) return new Response("not this room", { status: 403 })
  const allowed = clipLimit().take(caller(request))
  if (!allowed.ok) {
    return new Response("too many clips at once", { status: 429, headers: { "Retry-After": String(allowed.retryAfter) } })
  }

  const path = new URL(request.url).searchParams.get("path")
  if (!path) return new Response("no path", { status: 400 })

  const ext = path.slice(path.lastIndexOf(".")).toLowerCase()
  if (!(ext in PLAYABLE)) return new Response("not audio", { status: 400 })

  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return new Response("not there", { status: 404 })
  }

  const dirs = homes()
  if (!dirs.some((dir) => real.startsWith(dir + sep))) {
    return new Response("not a clip this room made", { status: 403 })
  }

  const size = statSync(real).size
  const stream = Readable.toWeb(createReadStream(real)) as ReadableStream
  return new Response(stream, {
    headers: {
      "Content-Type": PLAYABLE[ext],
      "Content-Length": String(size),
      // The filename carries a timestamp, so a clip never changes under a URL.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  })
}
