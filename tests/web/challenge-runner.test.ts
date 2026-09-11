import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runChallenge } from "@/lib/challenge-runner"
import { ChallengeStore } from "@/lib/challenge-store"
import { deliver, forget, openChat } from "@/lib/group"
import type { RoomEvent } from "@/lib/room-stream"

vi.mock("@/lib/group", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/group")>(),
  deliver: vi.fn(), forget: vi.fn(async () => 3), openChat: vi.fn(async () => {}),
}))
const group = ["Steve", "Jordan", "Pepe"].map((name) => ({ name, url: "http://localhost:9", key: "test" }))
let db: ChallengeStore
beforeEach(() => { db = new ChallengeStore(":memory:"); vi.clearAllMocks(); vi.spyOn(console, "info").mockImplementation(() => {}) })
afterEach(() => { db.close(); vi.restoreAllMocks() })
async function run(signal = new AbortController().signal) {
  const attempt = db.create("owner")
  const events: RoomEvent[] = []
  await runChallenge({ run: attempt, group, message: "private prompt", store: db, signal, emit: (event) => events.push(event) })
  return { result: db.get(attempt.id), events, id: attempt.id }
}

describe("one-prompt challenge runner", () => {
  it("counts three replies to one prompt, not introductions or silence", async () => {
    vi.mocked(deliver).mockImplementation(async (_agent, _chat, speaker) => speaker === "you" ? { spoke: true, text: "I am 30", audio: null } : { spoke: false })
    const { result, events } = await run()
    expect(result).toMatchObject({ score: 3, status: "quiet" })
    expect(events.filter((event) => event.type === "said")).toHaveLength(3)
    expect(events.at(-1)).toEqual({ type: "done" })
    expect(vi.mocked(deliver).mock.calls.every((call) => call[1] === "room")).toBe(true)
    expect(openChat).not.toHaveBeenCalled()
    expect(forget).not.toHaveBeenCalled()
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("private prompt")
  })
  it("counts agent-to-agent replies with no ceiling, and ends when the room does", async () => {
    // Twenty-five replies, then everybody has said their piece. The old game
    // stopped at twenty whatever happened next; this one stops when they do.
    let answers = 25
    vi.mocked(deliver).mockImplementation(async (_agent, _chat, speaker) =>
      speaker === "System" || answers-- <= 0 ? { spoke: false } : { spoke: true, text: "And you?", audio: null })
    const { result, events } = await run()
    expect(result).toMatchObject({ score: 25, status: "quiet" })
    expect(events.filter((event) => event.type === "said")).toHaveLength(25)
  })
  it("stops the moment the stored attempt does, whatever is still being said", async () => {
    // The deadline, a stop, a crash recovery: every one of them reaches the
    // runner as a stored run that is no longer running, and nothing after it
    // costs a paid turn.
    let replies = 0
    vi.mocked(deliver).mockImplementation(async (_agent, _chat, speaker) => {
      if (speaker === "System") return { spoke: false }
      if (++replies === 4) db.finish(db.latest("owner")!.id, "stopped")
      return { spoke: true, text: "Still talking", audio: null }
    })
    const { result } = await run()
    expect(result).toMatchObject({ score: 3, status: "stopped" })
    expect(deliver).toHaveBeenCalledTimes(5)
  })
  it("does not count failed replies or reveal provider failures", async () => {
    vi.mocked(deliver).mockImplementation(async (_agent, _chat, speaker) => speaker === "System" ? { spoke: false } : { spoke: false, error: "private-provider-key" })
    const { result, events } = await run()
    expect(result).toMatchObject({ score: 0, status: "failed" })
    expect(JSON.stringify(events)).not.toContain("private-provider-key")
  })
  it("starts independent listeners together rather than adding their latency", async () => {
    const resolvers: (() => void)[] = []
    vi.mocked(deliver).mockImplementation(() => new Promise((resolve) => resolvers.push(() => resolve({ spoke: false }))))
    const pending = run()
    expect(deliver).toHaveBeenCalledTimes(3)
    resolvers.forEach((resolve) => resolve())
    expect((await pending).result).toMatchObject({ score: 0, status: "quiet" })
  })
  it("waits for every in-flight listener on cancellation and keeps the history", async () => {
    const controller = new AbortController()
    const resolvers: (() => void)[] = []
    vi.mocked(deliver).mockImplementation(() => new Promise((resolve) => resolvers.push(() => resolve({ spoke: true, text: "late reply", audio: null }))))
    let finished = false
    const pending = run(controller.signal).then((result) => { finished = true; return result })
    controller.abort()
    resolvers[0]()
    await Promise.resolve()
    expect(finished).toBe(false)
    resolvers.slice(1).forEach((resolve) => resolve())
    expect((await pending).result).toMatchObject({ score: 0, status: "stopped" })
    expect(forget).not.toHaveBeenCalled()
  })
  it("aborts before delivery without deleting shared context", async () => {
    const controller = new AbortController()
    controller.abort()
    const { result } = await run(controller.signal)
    expect(result.status).toBe("stopped")
    expect(deliver).not.toHaveBeenCalled()
    expect(forget).not.toHaveBeenCalled()
  })
})
