import { isChallengeRun, type ChallengeRun } from "./challenge"

export type RoomEvent =
  | { type: "thinking" | "quiet"; agent: string }
  | { type: "said"; agent: string; text: string; audio: string | null }
  | { type: "failed"; agent: string; error: string }
  | { type: "done" }
  | { type: "challenge"; run: ChallengeRun }

function parseEvent(data: string): RoomEvent {
  const event = JSON.parse(data)
  if (event?.type === "done") return { type: "done" }
  if (event?.type === "challenge" && isChallengeRun(event.run)) return { type: "challenge", run: event.run }
  if (!event || typeof event.agent !== "string") throw new Error("Invalid room event")
  if (event.type === "thinking" || event.type === "quiet") return event
  if (event.type === "said" && typeof event.text === "string" && (event.audio === null || typeof event.audio === "string")) return event
  if (event.type === "failed" && typeof event.error === "string") return event
  throw new Error("Invalid room event")
}

/** Decode SSE across arbitrary UTF-8 and line boundaries. EOF without done is a failure. */
export async function* roomEvents(response: Response): AsyncGenerator<RoomEvent> {
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    throw new Error("The room could not receive your message.")
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (buffer.length > 1_000_000) throw new Error("Room event too large")
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const chunk = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const data = chunk.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n")
        if (!data) continue
        const event = parseEvent(data)
        yield event
        if (event.type === "done") return
      }
      if (done) break
    }
    throw new Error("The connection ended before the room finished.")
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
