import type { Agent } from "./agents"
import { audienceFor, deliver, ROOM } from "./group"
import { UNNAMED } from "./player"
import type { RoomEvent } from "./room-stream"
import { grantFor } from "./speech-grant"

// Shared across route bundles in the single Node process. Scored and ordinary
// prompts must not interleave in the same agents' histories.
const state = globalThis as typeof globalThis & { __roomRound?: symbol }
export function acquireRoom(): (() => void) | null {
  if (state.__roomRound) return null
  const token = Symbol("room-round")
  state.__roomRound = token
  return () => { if (state.__roomRound === token) delete state.__roomRound }
}

/** Ordinary chat and scored chat use the same sessions and delivery loop. */
export async function runRoomRound({ group, message, speaker = UNNAMED, signal, emit, remaining = () => Infinity, replied }: {
  group: Agent[]; message: string; speaker?: string; signal: AbortSignal; emit: (event: RoomEvent) => void;
  remaining?: () => number; replied?: () => void;
}) {
  let failed = false
  // The person's own name when they have claimed the room, so the agents can
  // answer them the way they answer each other — by name.
  let pending = [{ speaker, text: message }]
  while (pending.length && remaining() > 0) {
    const next: typeof pending = []
    for (const line of pending) {
      const audience = audienceFor(group, line.speaker)
      let cursor = 0
      while (cursor < audience.length && remaining() > 0) {
        signal.throwIfAborted()
        // Each in-flight call reserves one possible point. At 19 only one
        // agent runs; earlier, independent agents can answer in parallel.
        const batch = audience.slice(cursor, cursor + Math.min(audience.length, remaining()))
        cursor += batch.length
        const settled = await Promise.allSettled(batch.map(async (agent) => {
          emit({ type: "thinking", agent: agent.name })
          const reply = await deliver(agent, ROOM, line.speaker, line.text, signal)
          signal.throwIfAborted()
          if (reply.spoke) {
            // Signed here, at the one place a reply becomes something the room
            // has said. The browser hands this back to ask for the voice.
            emit({ type: "said", agent: agent.name, text: reply.text, audio: reply.audio, grant: grantFor(agent.name, reply.text) })
            replied?.()
            next.push({ speaker: agent.name, text: reply.text })
          } else if (reply.error) {
            failed = true
            emit({ type: "failed", agent: agent.name, error: "Agent unavailable" })
          } else emit({ type: "quiet", agent: agent.name })
        }))
        // Release the room only after all calls settle, including cancellation.
        const rejected = settled.find((result) => result.status === "rejected")
        if (rejected?.status === "rejected") throw rejected.reason
      }
      if (remaining() <= 0) break
    }
    pending = next
  }
  return { failed }
}
