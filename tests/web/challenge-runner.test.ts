import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runChallenge } from "@/lib/challenge-runner"
import { ChallengeStore } from "@/lib/challenge-store"
import { deliver, forget, openChat } from "@/lib/group"
import type { RoomEvent } from "@/lib/room-stream"

vi.mock("@/lib/personas", () => ({ cast: () => [], briefing: () => "" }))
vi.mock("@/lib/group", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/group")>(),
  deliver: vi.fn(), forget: vi.fn(async () => 3), openChat: vi.fn(async () => {}),
}))
const group = ["Anna", "Jordan", "Pepe"].map((name) => ({ name, url: "http://localhost:9", key: "test" }))
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
    const { result, events, id } = await run()
    expect(result).toMatchObject({ score: 3, status: "quiet" })
    expect(events.filter((event) => event.type === "said")).toHaveLength(3)
    expect(events.at(-1)).toEqual({ type: "done" })
    expect(openChat).toHaveBeenCalledWith(group[0], `challenge-${id}`, expect.any(AbortSignal))
    expect(forget).toHaveBeenCalledWith(group, `challenge-${id}`)
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("private prompt")
  })
  it("stops at 20, including agent-to-agent replies, without extra paid turns", async () => {
    vi.mocked(deliver).mockImplementation(async (_agent, _chat, speaker) => speaker === "System" ? { spoke: false } : { spoke: true, text: "And you?", audio: null })
    const { result, events } = await run()
    expect(result).toMatchObject({ score: 20, status: "won" })
    expect(deliver).toHaveBeenCalledTimes(23)
    expect(events.filter((event) => event.type === "said")).toHaveLength(20)
  })
  it("does not count failed replies or reveal provider failures", async () => {
    vi.mocked(deliver).mockImplementation(async (_agent, _chat, speaker) => speaker === "System" ? { spoke: false } : { spoke: false, error: "private-provider-key" })
    const { result, events } = await run()
    expect(result).toMatchObject({ score: 0, status: "failed" })
    expect(JSON.stringify(events)).not.toContain("private-provider-key")
  })
  it("aborts before delivery and still cleans up only its own sessions", async () => {
    const controller = new AbortController()
    controller.abort()
    const { result } = await run(controller.signal)
    expect(result.status).toBe("stopped")
    expect(deliver).not.toHaveBeenCalled()
    expect(forget).toHaveBeenCalledOnce()
  })
})
