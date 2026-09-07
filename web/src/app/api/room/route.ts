import { agents, type Agent } from "@/lib/agents"
import { deliver, forget, openChat, ROOM, roster } from "@/lib/group"
import { briefing, cast } from "@/lib/personas"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Open the room and introduce everyone in it.
 *
 * Costs a turn per agent, which is why it is worth not doing twice: an agent
 * that was never introduced knows only its own name, and cannot tell a question
 * aimed at somebody else from one aimed at itself.
 *
 * Each agent is told who it is in the same message, so the room still costs one
 * turn per agent rather than two.
 */
async function introduce(group: Agent[], people: string[]) {
  const hands = cast(group.map((a) => a.name))
  await Promise.all(
    group.map(async (agent, i) => {
      await openChat(agent, ROOM)
      // Identity first, then the situation — the roster ends with how to write
      // a reply, and that is the instruction worth having last.
      const persona = hands[i]
      const opening = [persona && briefing(persona), roster(group, people, agent.name)]
        .filter(Boolean)
        .join("\n\n")
      await deliver(agent, ROOM, "System", opening)
    }),
  )
}

/**
 * One introduction at a time, for the whole server.
 *
 * `holds` is a read, and two requests can both read "not yet" before either
 * has written anything — which is not hypothetical: opening the page while
 * curling the same route introduced the room twice, and every agent started
 * with two copies of who it was. React's double-effect in development makes it
 * the normal case rather than a race you have to be unlucky to hit.
 *
 * A promise is enough because there is one Next process. The second caller
 * waits on the first rather than starting its own.
 */
let opening: Promise<void> | null = null

async function open(group: Agent[]) {
  opening ??= (async () => {
    const known = await Promise.all(group.map(holds))
    if (known.some((yes) => !yes)) await introduce(group, ["you"])
  })().finally(() => {
    opening = null
  })
  return opening
}

/** Whether an agent already holds the room, so opening it twice is free. */
async function holds(agent: Agent): Promise<boolean> {
  try {
    const res = await fetch(`${agent.url}/api/sessions/${ROOM}/messages`, {
      headers: { Authorization: `Bearer ${agent.key}` },
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    })
    if (!res.ok) return false
    const data = await res.json()
    return ((data.messages ?? data.data ?? []) as unknown[]).length > 0
  } catch {
    return false
  }
}

/**
 * The room, opening it if this is the first time anyone asked.
 *
 * There is one room and it has no front door. It used to be a list you picked
 * from and a button that made another, which is a choice nobody in this demo
 * wanted to make: the interesting thing is three agents deciding whether a line
 * is theirs, not which conversation it happened in.
 */
export async function GET() {
  const group = agents()
  if (!group.length) {
    return Response.json({ error: "no agents configured" }, { status: 503 })
  }

  await open(group)
  return Response.json({ chat: ROOM, agents: group.map((a) => a.name) })
}

/**
 * Empty the room.
 *
 * Deletes the session on every agent and opens a fresh one, which is the only
 * way to make a turn stop carrying what came before: history is the session,
 * and an agent asked to ignore it would still be reading it.
 *
 * The cast survives. Whoever was in support before is in support after — a
 * cleared context is the same people with nothing behind them, not a different
 * group wearing the same names.
 */
export async function DELETE() {
  const group = agents()
  if (!group.length) {
    return Response.json({ error: "no agents configured" }, { status: 503 })
  }

  const gone = await forget(group, ROOM)
  if (!gone) return Response.json({ error: "no agent took the clear" }, { status: 502 })
  await introduce(group, ["you"])

  // Partial is worth saying out loud: whichever agent did not answer still has
  // every line of it, and will answer as though the conversation continued.
  return Response.json({ chat: ROOM, agents: gone, complete: gone === group.length })
}
