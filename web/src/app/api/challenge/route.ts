import { agents } from "@/lib/agents"
import { CHALLENGE_DURATION_MS, CHALLENGE_PROMPT_LIMIT } from "@/lib/challenge"
import { challengeBody, challengeFailure, owner, privateHeaders } from "@/lib/challenge-http"
import { runChallenge } from "@/lib/challenge-runner"
import { ChallengeError, challengeStore } from "@/lib/challenge-store"
import type { RoomEvent } from "@/lib/room-stream"
import { playerName, UNNAMED } from "@/lib/player"
import { acquireRoom } from "@/lib/room-round"
import { ensureRoom } from "@/lib/room-session"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

export async function GET() {
  try {
    const who = await owner()
    const store = challengeStore()
    const run = who ? store.latest(who) : null
    // A published run comes back with its place on the board. A reload after a
    // win should show the same "#4 of 61" the round itself ended on, rather
    // than a score with nowhere to put it.
    return Response.json({ run, standing: run?.submitted ? store.standing(run.id) : null }, { headers: privateHeaders })
  } catch (error) { return challengeFailure(error) }
}

export async function POST(request: Request) {
  let release: (() => void) | null = null
  try {
    const body = await challengeBody(request)
    if (Object.keys(body).some((key) => key !== "message" && key !== "speaker") || typeof body.message !== "string" || !body.message.trim() || body.message.length > CHALLENGE_PROMPT_LIMIT) {
      throw new ChallengeError(400, `Send one prompt of up to ${CHALLENGE_PROMPT_LIMIT} characters.`)
    }
    const group = agents()
    if (group.length < 2) throw new ChallengeError(503, "At least two agents must be configured.")
    // A scored round runs in the same room and lands in the same transcript, so
    // the player is the same person here as everywhere else — checked the same
    // way, because it reaches the agents as the same `Name:` prefix.
    const speaker = body.speaker === undefined || body.speaker === null
      ? UNNAMED
      : playerName(body.speaker, group.map((agent) => agent.name))
    if (!speaker) throw new ChallengeError(400, "That name can’t be used in this room.")
    release = acquireRoom()
    if (!release) throw new ChallengeError(409, "The room is responding. Start counting when it finishes.")
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
        void ensureRoom(group, signal, speaker).then(() => runChallenge({ run, group, message: body.message as string, speaker, store, signal, emit })).catch(() => {
          // An initialization/storage failure must not create an unhandled rejection or
          // invent a successful result. The client can recover persisted state.
          try { emit({ type: "challenge", run: store.finish(run.id, signal.aborted ? "stopped" : "failed") }); emit({ type: "done" }) } catch { /* Storage may be unavailable. */ }
          console.error(JSON.stringify({ event: "challenge.run_error", version: 1 }))
        }).finally(() => {
          clearInterval(heartbeat)
          release?.()
          if (!closed) { closed = true; controller.close() }
        })
      },
      cancel() { closed = true; cancel.abort(); store.finish(run.id, "stopped") },
    })
    return new Response(stream, { headers: { ...privateHeaders, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no", "Cache-Control": "no-cache, no-store, no-transform" } })
  } catch (error) { release?.(); return challengeFailure(error) }
}
