import { agents } from "@/lib/agents"
import { CHALLENGE_DURATION_MS, CHALLENGE_PROMPT_LIMIT } from "@/lib/challenge"
import { challengeBody, challengeFailure, owner, privateHeaders } from "@/lib/challenge-http"
import { runChallenge } from "@/lib/challenge-runner"
import { ChallengeError, challengeStore } from "@/lib/challenge-store"
import type { RoomEvent } from "@/lib/room-stream"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

export async function GET() {
  try {
    const who = await owner()
    return Response.json({ run: who ? challengeStore().latest(who) : null }, { headers: privateHeaders })
  } catch (error) { return challengeFailure(error) }
}

export async function POST(request: Request) {
  try {
    const body = await challengeBody(request)
    if (Object.keys(body).some((key) => key !== "message") || typeof body.message !== "string" || !body.message.trim() || body.message.length > CHALLENGE_PROMPT_LIMIT) {
      throw new ChallengeError(400, `Send one prompt of up to ${CHALLENGE_PROMPT_LIMIT} characters.`)
    }
    const group = agents()
    if (group.length < 2) throw new ChallengeError(503, "At least two agents must be configured.")
    const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https"
    const who = (await owner(true, secure))!
    const store = challengeStore()
    const run = store.create(who)
    const cancel = new AbortController()
    const signal = AbortSignal.any([request.signal, cancel.signal, AbortSignal.timeout(CHALLENGE_DURATION_MS)])
    const encoder = new TextEncoder()
    let closed = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: RoomEvent) => {
          if (closed) return
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) }
          catch { closed = true; cancel.abort() }
        }
        const heartbeat = setInterval(() => {
          if (!closed) { try { controller.enqueue(encoder.encode(": heartbeat\n\n")) } catch { closed = true; cancel.abort() } }
        }, 15_000)
        emit({ type: "challenge", run })
        void runChallenge({ run, group, message: body.message as string, store, signal, emit }).catch(() => {
          // A storage/cleanup failure must not create an unhandled rejection or
          // invent a successful result. The client can recover persisted state.
          try { store.finish(run.id, "failed") } catch { /* Storage may be unavailable. */ }
          console.error(JSON.stringify({ event: "challenge.storage_error", version: 1 }))
        }).finally(() => {
          clearInterval(heartbeat)
          if (!closed) { closed = true; controller.close() }
        })
      },
      cancel() { closed = true; cancel.abort(); store.finish(run.id, "stopped") },
    })
    return new Response(stream, { headers: { ...privateHeaders, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no", "Cache-Control": "no-cache, no-store, no-transform" } })
  } catch (error) { return challengeFailure(error) }
}
