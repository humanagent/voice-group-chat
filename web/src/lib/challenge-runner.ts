import type { Agent } from "./agents"
import { runRoomRound } from "./room-round"
import { ROOM } from "./group"
import type { RoomEvent } from "./room-stream"
import type { ChallengeRun } from "./challenge"
import type { ChallengeStore } from "./challenge-store"

/** Count this prompt's new replies in the existing room. Never erase it. */
export async function runChallenge({ run, group, message, speaker, store, signal, emit }: {
  run: ChallengeRun; group: Agent[]; message: string; speaker?: string; store: ChallengeStore;
  signal: AbortSignal; emit: (event: RoomEvent) => void;
}) {
  const started = performance.now()
  try {
    const { failed } = await runRoomRound({ group, message, speaker, signal, emit,
      remaining: () => run.status === "running" ? run.target - run.score : 0,
      replied: () => { run = store.increment(run.id); emit({ type: "challenge", run }) },
    })
    run = store.finish(run.id, failed ? "failed" : "quiet")
  } catch {
    run = store.finish(run.id, signal.aborted ? signal.reason?.name === "TimeoutError" ? "timeout" : "stopped" : "failed")
  } finally {
    emit({ type: "challenge", run })
    emit({ type: "done" })
    console.info(JSON.stringify({ event: "challenge.finished", version: 1, chat: ROOM, score: run.score, outcome: run.status, durationMs: Math.round(performance.now() - started) }))
  }
}
