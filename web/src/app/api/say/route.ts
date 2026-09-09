import { agents } from "@/lib/agents"
import { ROOM } from "@/lib/group"
import { acquireRoom, runRoomRound } from "@/lib/room-round"
import { ensureRoom } from "@/lib/room-session"
import type { RoomEvent } from "@/lib/room-stream"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(request: Request) {
  const group = agents()
  if (!group.length) return Response.json({ error: "No agents configured." }, { status: 503 })
  let body
  try { body = await request.json() } catch { return Response.json({ error: "Invalid message." }, { status: 400 }) }
  if (body?.chat !== ROOM || (body.speaker ?? "you") !== "you" || typeof body.message !== "string" || !body.message.trim()) {
    return Response.json({ error: "Invalid room or message." }, { status: 400 })
  }
  const release = acquireRoom()
  if (!release) return Response.json({ error: "The room is responding. Try again when it finishes." }, { status: 409 })
  const cancel = new AbortController()
  const signal = AbortSignal.any([request.signal, cancel.signal, AbortSignal.timeout(240_000)])
  const encoder = new TextEncoder()
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: RoomEvent) => {
        if (closed) return
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) }
        catch { closed = true; cancel.abort() }
      }
      void (async () => {
        await ensureRoom(group, signal)
        await runRoomRound({ group, message: body.message, signal, emit })
        emit({ type: "done" })
      })().catch(() => {
        if (!closed) { closed = true; controller.error(new Error("Room interrupted")) }
      }).finally(() => {
        release()
        if (!closed) { closed = true; controller.close() }
      })
    },
    cancel() { closed = true; cancel.abort() },
  })
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store, no-transform", "X-Accel-Buffering": "no" } })
}
