import type { Agent } from "./agents"
import { deliver, openChat, ROOM, roster } from "./group"
import { briefing, cast } from "./personas"

/** Initialize only missing shared sessions, never reset existing context. */
export async function ensureRoom(group: Agent[], signal?: AbortSignal) {
  const personas = cast(group.map((agent) => agent.name))
  const settled = await Promise.allSettled(group.map(async (agent, index) => {
    const response = await fetch(`${agent.url}/api/sessions/${ROOM}/messages`, {
      headers: { Authorization: `Bearer ${agent.key}` }, cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    })
    if (response.ok) {
      const data = await response.json()
      if ((data.messages ?? data.data ?? []).length) return
    } else if (response.status !== 404) throw new Error("Room unavailable")
    await openChat(agent, ROOM, signal)
    signal?.throwIfAborted()
    const persona = personas[index]
    const opening = [persona && briefing(persona), roster(group, ["you"], agent.name)].filter(Boolean).join("\n\n")
    const reply = await deliver(agent, ROOM, "System", opening, signal)
    if (!reply.spoke && reply.error) throw new Error("Room unavailable")
  }))
  if (settled.some((result) => result.status === "rejected")) throw new Error("Room unavailable")
}
