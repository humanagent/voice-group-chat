import { afterEach, describe, expect, it, vi } from "vitest"
import { ensureRoom } from "@/lib/room-session"
import { runRoomRound } from "@/lib/room-round"
import { deliver } from "@/lib/group"

vi.mock("@/lib/group", async (original) => ({ ...await original<typeof import("@/lib/group")>(), deliver: vi.fn(async () => ({ spoke: false })), openChat: vi.fn(async () => {}) }))
const group = ["Anna", "Jordan", "Pepe"].map((name) => ({ name, url: `http://${name.toLowerCase()}.test`, key: "test" }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe("the room hears the person by name", () => {
  it("puts the player's name in front of what they said", async () => {
    // The whole point. An agent reads `Fabri: …` and can answer the person the
    // way it answers Anna and Pepe — by name.
    await runRoomRound({ group, message: "hola", speaker: "Fabri", signal: AbortSignal.timeout(5000), emit: () => {} })
    for (const agent of group) {
      expect(deliver).toHaveBeenCalledWith(agent, "room", "Fabri", "hola", expect.anything())
    }
  })

  it("still says `you` for a room nobody has claimed", async () => {
    await runRoomRound({ group, message: "hola", signal: AbortSignal.timeout(5000), emit: () => {} })
    expect(deliver).toHaveBeenCalledWith(group[0], "room", "you", "hola", expect.anything())
  })

  it("tells a new room who the person is, not that somebody is `you`", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })))
    await ensureRoom(group, undefined, "Fabri")
    const opening = vi.mocked(deliver).mock.calls[0][3]
    expect(opening).toContain("Fabri")
    expect(opening).not.toContain("In this chat: you")
  })
})
