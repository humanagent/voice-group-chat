import { agents } from "@/lib/agents"
import { forget, ROOM } from "@/lib/group"
import { acquireRoom } from "@/lib/room-round"
import { ensureRoom } from "@/lib/room-session"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET() {
  const group = agents()
  if (!group.length) return Response.json({ error: "No agents configured." }, { status: 503 })
  const release = acquireRoom()
  try {
    // Reads during a round must never insert introductions into that round.
    // Every writer also ensures initialization while holding this same lock.
    if (release) await ensureRoom(group, AbortSignal.timeout(30_000))
    return Response.json({ chat: ROOM, agents: group.map((agent) => agent.name) })
  } catch { return Response.json({ error: "The room is unavailable." }, { status: 503 }) }
  finally { release?.() }
}

/** Explicit clearing is for API clients, never navigation or counting. */
export async function DELETE() {
  const group = agents()
  const release = acquireRoom()
  if (!release) return Response.json({ error: "The room is responding. Wait before clearing it." }, { status: 409 })
  try {
    const gone = await forget(group, ROOM)
    if (!gone) return Response.json({ error: "No agent took the clear." }, { status: 502 })
    await ensureRoom(group, AbortSignal.timeout(30_000))
    return Response.json({ chat: ROOM, agents: gone, complete: gone === group.length })
  } catch { return Response.json({ error: "The room could not reopen." }, { status: 503 }) }
  finally { release() }
}
