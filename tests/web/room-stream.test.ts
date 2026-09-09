import { describe, expect, it } from "vitest"
import { roomEvents, type RoomEvent } from "@/lib/room-stream"

function stream(text: string, width = 1) {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += width) controller.enqueue(bytes.slice(i, i + width))
    controller.close()
  } }), { headers: { "Content-Type": "text/event-stream" } })
}
async function collect(response: Response) {
  const result: RoomEvent[] = []
  for await (const event of roomEvents(response)) result.push(event)
  return result
}

describe("the room stream", () => {
  it("keeps accented and emoji text intact across single-byte UTF-8 chunks", async () => {
    const event = { type: "said", agent: "Anna", text: "Sí, café ☕", audio: null }
    expect(await collect(stream(`: heartbeat\r\n\r\ndata:${JSON.stringify(event)}\r\n\r\ndata: {"type":"done"}\r\n\r\n`))).toEqual([event, { type: "done" }])
  })
  it("treats a closed stream without done as an interrupted conversation", async () => {
    await expect(collect(stream('data: {"type":"thinking","agent":"Anna"}\n\n'))).rejects.toThrow("connection ended")
  })
  it("surfaces HTTP failures and malformed messages", async () => {
    await expect(collect(new Response("unavailable", { status: 503 }))).rejects.toThrow("could not receive")
    await expect(collect(stream('data: {"type":"said","agent":"Anna","text":42}\n\n'))).rejects.toThrow("Invalid room event")
  })
})
