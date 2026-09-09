import type { Agent } from "./agents"
import { audienceFor, deliver, forget, openChat, roster } from "./group"
import { briefing, cast } from "./personas"
import type { RoomEvent } from "./room-stream"
import type { ChallengeRun } from "./challenge"
import type { ChallengeStore } from "./challenge-store"

/** Fresh, server-named sessions; introductions never contribute to the score. */
export async function runChallenge({ run, group, message, store, signal, emit }: {
  run: ChallengeRun; group: Agent[]; message: string; store: ChallengeStore;
  signal: AbortSignal; emit: (event: RoomEvent) => void;
}) {
  const chat = `challenge-${run.id}`
  let hadFailure = false
  try {
    const personas = cast(group.map((agent) => agent.name))
    const introduced = await Promise.all(group.map(async (agent, index) => {
      await openChat(agent, chat, signal)
      signal.throwIfAborted()
      const opening = [personas[index] && briefing(personas[index]), roster(group, ["you"], agent.name)].filter(Boolean).join("\n\n")
      return deliver(agent, chat, "System", opening, signal)
    }))
    signal.throwIfAborted()
    if (introduced.some((reply) => !reply.spoke && reply.error)) throw new Error("Introduction failed")
    let pending = [{ speaker: "you", text: message }]
    while (pending.length && run.status === "running") {
      const next: typeof pending = []
      for (const line of pending) {
        // Sequential delivery makes the 20th reply an exact hard stop, without
        // paying for extra in-flight replies or awarding an overshoot.
        for (const agent of audienceFor(group, line.speaker)) {
          signal.throwIfAborted()
          if (run.status !== "running") break
          emit({ type: "thinking", agent: agent.name })
          const reply = await deliver(agent, chat, line.speaker, line.text, signal)
          signal.throwIfAborted()
          if (reply.spoke) {
            run = store.increment(run.id)
            emit({ type: "said", agent: agent.name, text: reply.text, audio: reply.audio })
            emit({ type: "challenge", run })
            next.push({ speaker: agent.name, text: reply.text })
          } else if (reply.error) {
            hadFailure = true
            emit({ type: "failed", agent: agent.name, error: "Agent unavailable" })
          } else emit({ type: "quiet", agent: agent.name })
        }
        if (run.status !== "running") break
      }
      pending = next
    }
    run = store.finish(run.id, hadFailure ? "failed" : "quiet")
  } catch {
    run = store.finish(run.id, signal.aborted ? signal.reason?.name === "TimeoutError" ? "timeout" : "stopped" : "failed")
  } finally {
    emit({ type: "challenge", run })
    emit({ type: "done" })
    // Only this attempt's generated sessions; never the shared room. No model calls.
    await forget(group, chat)
    console.info(JSON.stringify({ event: "challenge.finished", version: 1, score: run.score, outcome: run.status }))
  }
}
