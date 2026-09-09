import { type Agent, agents } from "@/lib/agents"
import { audienceFor, deliver, ROOM } from "@/lib/group"

export const dynamic = "force-dynamic"
export const maxDuration = 300

type Event =
  | { type: "thinking"; agent: string }
  | { type: "said"; agent: string; text: string; audio: string | null }
  | { type: "quiet"; agent: string }
  | { type: "failed"; agent: string; error: string }
  | { type: "done" }

/**
 * One turn of the room, streamed as it happens.
 *
 * Each agent's line is sent the moment it lands rather than when the round
 * finishes: they answer independently and at different speeds, and collecting
 * the round before showing any of it means one agent's bad minute is everyone's
 * wait.
 */
export async function POST(request: Request) {
  const group = agents()
  if (!group.length) {
    return Response.json({ error: "no agents configured" }, { status: 503 })
  }

  const { chat, message, speaker = "you" } = await request.json()
  if (!chat || !message) {
    return Response.json({ error: "chat and message are required" }, { status: 400 })
  }
  // Challenge sessions are server-owned: this public room endpoint must not
  // inject additional prompts or impersonated speakers into a scored attempt.
  if (chat !== ROOM || speaker !== "you") return Response.json({ error: "invalid room" }, { status: 400 })

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (event: Event) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))

      // Every quiet turn is reported, including the second one a single line
      // of yours can cause — once as you typed it, once relayed as somebody's
      // reply. `thinking` is a condition with no timeout, so an agent that
      // thought and then went quiet unreported spins its orb forever. There is
      // nothing to de-duplicate: a quiet turn is a state now, not a line, and
      // arriving at the same state twice costs the reader nothing.

      // No cap, and no filter. A round ends when nobody had anything to add —
      // every line reaches everyone, and each agent decides for itself whether
      // to answer. Two agents who keep answering each other will keep going;
      // closing the tab aborts the request and the round with it.
      let pending = [{ speaker, text: String(message) }]
      while (pending.length) {
        const next: typeof pending = []
        for (const line of pending) {
          const audience = audienceFor(group, line.speaker)
          if (!audience.length) continue
          await Promise.all(
            audience.map(async (agent: Agent) => {
              send({ type: "thinking", agent: agent.name })
              const reply = await deliver(agent, chat, line.speaker, line.text)
              if (reply.spoke) {
                send({ type: "said", agent: agent.name, text: reply.text, audio: reply.audio })
                next.push({ speaker: agent.name, text: reply.text })
              } else if (reply.error) {
                send({ type: "failed", agent: agent.name, error: reply.error })
              } else {
                send({ type: "quiet", agent: agent.name })
              }
            }),
          )
        }
        pending = next
      }

      send({ type: "done" })
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
