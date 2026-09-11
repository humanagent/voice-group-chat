import { beforeEach, describe, expect, it, vi } from "vitest"

import { history, splitAudio } from "@/lib/group"

const agent = { name: "Steve", url: "http://agent", key: "k" }

/** One session's messages, as the gateway hands them back. */
function session(messages: { role: string; content: string }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ messages }), { status: 200 })),
  )
}

beforeEach(() => vi.unstubAllGlobals())

describe("what a room reads back", () => {
  it("recovers the speaker from the prefix a line arrived with", async () => {
    session([
      { role: "user", content: "you: morning" },
      { role: "assistant", content: "Morning." },
      { role: "user", content: "Jordan: morning to you too" },
    ])
    expect(await history(agent, "room-1")).toEqual([
      { speaker: "you", text: "morning", spoken: false },
      { speaker: "Steve", text: "Morning.", spoken: false },
      { speaker: "Jordan", text: "morning to you too", spoken: false },
    ])
  })

  it("leaves the agent's own machinery out of the conversation", async () => {
    // A `tool` result used to fall through to the line parser, which accepted
    // anything before a colon as a name — so a memory write appeared in the
    // transcript as a member called `{"success"`.
    session([
      { role: "user", content: "you: remember that" },
      {
        role: "tool",
        content: '{"success": true, "done": true, "target": "memory", "entry_count": 4}',
      },
      { role: "assistant", content: "Noted." },
    ])
    const lines = await history(agent, "room-1")
    expect(lines.map((l) => l.speaker)).toEqual(["you", "Steve"])
    expect(JSON.stringify(lines)).not.toContain("success")
  })

  it("will not take a name that is not one", async () => {
    session([
      { role: "user", content: '"note": "Write saved."' },
      { role: "user", content: "[tool]: whatever" },
      { role: "user", content: "Fabri Guespe: a name with a space is still a name" },
    ])
    expect((await history(agent, "room-1")).map((l) => l.speaker)).toEqual(["Fabri Guespe"])
  })

  it("keeps the roster out of it", async () => {
    session([{ role: "user", content: "System: In this chat: you, Steve, Jordan" }])
    expect(await history(agent, "room-1")).toEqual([])
  })

  it("reads a silent turn as no line at all", async () => {
    session([
      { role: "assistant", content: "NO_REPLY" },
      { role: "assistant", content: "SILENT" },
      { role: "assistant", content: "" },
    ])
    expect(await history(agent, "room-1")).toEqual([])
  })

  it("marks a reply that was spoken, without reading the path out loud", async () => {
    session([{ role: "assistant", content: "MEDIA:/tmp/a.mp3\nOn my way." }])
    expect(await history(agent, "room-1")).toEqual([
      { speaker: "Steve", text: "On my way.", spoken: true },
    ])
  })

  it("says nothing rather than failing when an agent is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })))
    expect(await history(agent, "room-1")).toEqual([])
  })
})

describe("a spoken reply", () => {
  it("separates the clip from the words", () => {
    expect(splitAudio("MEDIA:/tmp/a.mp3\nHello.")).toEqual({
      audio: "/tmp/a.mp3",
      text: "Hello.",
    })
  })

  it("leaves a MEDIA line that is not audio in the message", () => {
    expect(splitAudio("MEDIA:./report.html\nHere it is.").audio).toBeNull()
  })
})

describe("deleting a room", () => {
  it("is only done when every agent has dropped it", async () => {
    // A room is the same session id opened on each gateway. One that missed
    // the delete keeps answering into a room the list no longer shows.
    const { forget } = await import("@/lib/group")
    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push(`${init.method} ${url}`)
        return new Response("", { status: 200 })
      }),
    )
    const group = [
      { name: "Steve", url: "http://a", key: "k" },
      { name: "Jordan", url: "http://b", key: "k" },
      { name: "Pepe", url: "http://c", key: "k" },
    ]
    expect(await forget(group, "room-1")).toBe(3)
    expect(seen).toEqual([
      "DELETE http://a/api/sessions/room-1",
      "DELETE http://b/api/sessions/room-1",
      "DELETE http://c/api/sessions/room-1",
    ])
  })

  it("counts a room an agent never had as one it no longer has", async () => {
    const { forget } = await import("@/lib/group")
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })))
    expect(await forget([{ name: "Steve", url: "http://a", key: "k" }], "room-1")).toBe(1)
  })

  it("reports the ones that did not take it rather than claiming success", async () => {
    const { forget } = await import("@/lib/group")
    let n = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1
        if (n === 2) throw new Error("down")
        return new Response("", { status: 200 })
      }),
    )
    const group = [
      { name: "Steve", url: "http://a", key: "k" },
      { name: "Jordan", url: "http://b", key: "k" },
    ]
    expect(await forget(group, "room-1")).toBe(1)
  })
})
