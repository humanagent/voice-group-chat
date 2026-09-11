import { afterEach, describe, expect, it, vi } from "vitest"
import { ensureRoom } from "@/lib/room-session"
import { deliver, openChat } from "@/lib/group"

vi.mock("@/lib/group", async (original) => ({ ...await original<typeof import("@/lib/group")>(), deliver: vi.fn(async () => ({ spoke: false })), openChat: vi.fn(async () => {}) }))
const group = ["Steve", "Jordan", "Pepe"].map((name) => ({ name, url: `http://${name.toLowerCase()}.test`, key: "test" }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe("shared room initialization", () => {
  it("reuses every existing history without introductions or new sessions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ messages: [{ role: "user", content: "Existing context" }] })))
    await ensureRoom(group)
    expect(deliver).not.toHaveBeenCalled()
    expect(openChat).not.toHaveBeenCalled()
  })
  it("initializes only the missing member, preserving the others' context", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("pepe") ? new Response(null, { status: 404 }) : Response.json({ messages: [{}] })))
    await ensureRoom(group)
    expect(openChat).toHaveBeenCalledExactlyOnceWith(group[2], "room", undefined)
    expect(deliver).toHaveBeenCalledExactlyOnceWith(group[2], "room", "System", expect.any(String), undefined)
  })
  it("never treats an upstream outage as permission to reintroduce agents", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })))
    await expect(ensureRoom(group)).rejects.toThrow("Room unavailable")
    expect(openChat).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })
})
