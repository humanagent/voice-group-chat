import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET, POST } from "@/app/api/challenge/route"
import { GET as scores, POST as publish } from "@/app/api/challenge/scoreboard/route"
import { GET as publicHistory } from "@/app/api/history/route"
import { POST as publicSay } from "@/app/api/say/route"
import { DELETE as clearRoom } from "@/app/api/room/route"
import { ensureRoom } from "@/lib/room-session"
import { ChallengeStore, challengeOwner, challengeStore } from "@/lib/challenge-store"
import { challengeBody, owner } from "@/lib/challenge-http"
import { roomEvents } from "@/lib/room-stream"

const cookie = vi.hoisted(() => ({ value: "a".repeat(64), set: vi.fn() }))
vi.mock("../../web/node_modules/next/headers.js", () => ({ cookies: async () => ({ get: () => cookie.value ? { value: cookie.value } : undefined, set: cookie.set }) }))
vi.mock("@/lib/challenge-store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/challenge-store")>(), challengeStore: vi.fn() }))
vi.mock("@/lib/agents", () => ({ agents: () => ["Anna", "Jordan", "Pepe"].map((name) => ({ name, url: "http://localhost:9", key: "test" })) }))
vi.mock("@/lib/room-session", () => ({ ensureRoom: vi.fn(async () => {}) }))
vi.mock("@/lib/group", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/group")>(),
  openChat: async () => {}, forget: async () => 3,
  deliver: async (_agent: unknown, _chat: string, speaker: string) => speaker === "you" ? { spoke: true, text: "A private reply", audio: null } : { spoke: false },
}))
let db: ChallengeStore
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("https://room.example/api/challenge", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://room.example", ...headers }, body: JSON.stringify(body),
})
beforeEach(() => {
  db = new ChallengeStore(":memory:")
  vi.mocked(challengeStore).mockReturnValue(db)
  cookie.value = "a".repeat(64)
  cookie.set.mockReset()
  vi.spyOn(console, "info").mockImplementation(() => {})
})
afterEach(() => { db.close(); vi.restoreAllMocks() })

describe("challenge HTTP boundary", () => {
  it("resolves the browser owner", async () => {
    expect(await owner()).toBe(challengeOwner(cookie.value))
  })
  it("streams a server score then publishes only the verified result", async () => {
    const response = await POST(request({ message: "Private prompt" }))
    const events = []
    for await (const event of roomEvents(response)) events.push(event)
    const run = (await (await GET()).json()).run
    expect(run).toMatchObject({ score: 3, status: "quiet", submitted: false })
    expect(events.filter((event) => event.type === "said")).toHaveLength(3)
    const saved = await publish(request({ runId: run.id, name: "José" }))
    expect(saved.status).toBe(200)
    // The round ends on a place, not a form: publication answers with it, and a
    // reload of the saved result answers with the same one.
    expect((await saved.json()).standing).toEqual({ rank: 1, total: 1 })
    expect(await (await GET()).json()).toMatchObject({ run: { submitted: true }, standing: { rank: 1, total: 1 } })
    const board = await scores()
    expect(board.headers.get("cache-control")).toBe("no-store")
    const body = await board.text()
    expect(body).toContain("José")
    expect(body).not.toMatch(/Private prompt|private reply|owner|runId|created_at/)
    expect(body).not.toContain(run.id)
  })
  it("rejects forged scores, speakers and sessions before starting a run", async () => {
    for (const body of [{ message: "hi", score: 20 }, { message: "hi", chat: "chosen" }, { message: "hi", speaker: "Anna" }]) {
      expect((await POST(request(body))).status).toBe(400)
    }
    expect(db.latest(challengeOwner(cookie.value))).toBeNull()
  })
  it("validates prompts and refuses oversized actual bytes", async () => {
    for (const message of ["", "   ", 42, "x".repeat(2001)]) expect((await POST(request({ message }))).status).toBe(400)
    expect((await POST(request({ message: "x".repeat(9000) }))).status).toBe(413)
    await expect(challengeBody(new Request("https://room.example", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }))).rejects.toThrow("Invalid JSON")
  })
  it("rejects cross-site writes and unsupported content types", async () => {
    expect((await POST(request({ message: "hi" }, { origin: "https://evil.example" }))).status).toBe(403)
    expect((await POST(request({ message: "hi" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403)
    expect((await POST(request({ message: "hi" }, { "content-type": "text/plain" }))).status).toBe(415)
  })
  it("a different browser cannot see or claim an attempt", async () => {
    const run = db.create(challengeOwner(cookie.value))
    db.finish(run.id, "quiet")
    cookie.value = "b".repeat(64)
    expect(await (await GET()).json()).toEqual({ run: null, standing: null })
    expect((await publish(request({ runId: run.id, name: "Fake" }))).status).toBe(404)
    cookie.value = ""
    expect((await publish(request({ runId: run.id, name: "Fake" }))).status).toBe(401)
  })
  it("uses a secure HttpOnly cookie and does not expose its value in events", async () => {
    cookie.value = ""
    const response = await POST(request({ message: "hi" }))
    expect(cookie.set).toHaveBeenCalledWith("room-challenger", expect.stringMatching(/^[a-f0-9]{64}$/), expect.objectContaining({ httpOnly: true, secure: true, sameSite: "strict" }))
    const body = await response.text()
    expect(body).not.toContain(cookie.set.mock.calls[0][1])
  })
  it("cannot publish client points, invalid names or unfinished attempts", async () => {
    const run = db.create(challengeOwner(cookie.value))
    expect((await publish(request({ runId: run.id, name: "Ada", score: 20 }))).status).toBe(400)
    expect((await publish(request({ runId: run.id, name: "<script>" }))).status).toBe(400)
    expect((await publish(request({ runId: run.id, name: "Ada" }))).status).toBe(409)
    expect(db.scoreboard()).toEqual([])
  })
  it("public room endpoints reject arbitrary sessions and forged speakers", async () => {
    expect((await publicSay(request({ chat: "challenge-private", message: "cheat" }))).status).toBe(400)
    expect((await publicSay(request({ chat: "room", message: "cheat", speaker: "Anna" }))).status).toBe(400)
    expect((await publicHistory(new Request("https://room.example/api/history?chat=challenge-private"))).status).toBe(404)
  })
  it("holds the shared room against overlapping prompts and resets", async () => {
    let release!: () => void
    vi.mocked(ensureRoom).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const first = await POST(request({ message: "Count this round" }))
    expect((await POST(request({ message: "Competing round" }))).status).toBe(409)
    expect((await publicSay(request({ chat: "room", message: "Interruption" }))).status).toBe(409)
    expect((await clearRoom()).status).toBe(409)
    release()
    await first.text()
    const ordinary = await publicSay(request({ chat: "room", message: "Continue the conversation" }))
    expect(ordinary.status).toBe(200)
    expect(await ordinary.text()).toContain("A private reply")
  })
})
