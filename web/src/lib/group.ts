import type { Agent } from "./agents"

/**
 * The room. There is one, and this is its name.
 *
 * A fixed id is what makes the room a place rather than a thing you open: the
 * browser, the terminal client and the log all mean the same conversation
 * without being told which.
 */
export const ROOM = "room"

/** What upstream says when a turn decided to stay quiet. */
const SILENT = new Set(["NO_REPLY", "SILENT", "HEARTBEAT_OK", "(empty)"])
const AUDIO = [".mp3", ".ogg", ".wav", ".m4a"]

/**
 * A line somebody said, as it is stored: `Name: what they said`.
 *
 * The name has to look like a name — letters first, then only what a name is
 * made of. Anything ending in a colon would also match a tool result opening
 * `{"success": true, …`, and a memory write would appear in the transcript
 * wearing a speaker's name.
 */
const SPOKE = /^\s*([\p{L}][\p{L}\p{M}\d .'’-]{0,23}):\s([\s\S]*)$/u

/**
 * What came back from one agent, and whether a turn happened at all.
 *
 * Silence and failure are different things and must never look the same. An
 * agent deciding a line was not its business is the behaviour worth showing; a
 * request that never reached it is a broken room wearing that behaviour as a
 * costume.
 */
export type Reply =
  | { spoke: true; text: string; audio: string | null }
  | { spoke: false; error?: string }

/** A spoken reply arrives as a `MEDIA:` line plus the words. Every client has
 *  to undo it; a hundred characters of file path is not something anyone said. */
export function splitAudio(reply: string): { audio: string | null; text: string } {
  let audio: string | null = null
  const said: string[] = []
  for (const line of (reply ?? "").split("\n")) {
    const trimmed = line.trim()
    if (line.startsWith("MEDIA:") && AUDIO.some((ext) => trimmed.endsWith(ext))) {
      audio = line.slice("MEDIA:".length).trim()
    } else {
      said.push(line)
    }
  }
  return { audio, text: said.join("\n").trim() }
}

async function post(agent: Agent, path: string, body: unknown, ms = 240_000, signal?: AbortSignal) {
  const res = await fetch(`${agent.url}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${agent.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : {}
}

/** Give one agent its own session for this chat. Each keeps a separate one
 *  under the same name, because history is per-agent: what Anna remembers of
 *  this room is not what Jordan remembers. */
export async function openChat(agent: Agent, chat: string, signal?: AbortSignal): Promise<void> {
  try {
    await post(agent, "/api/sessions", { session_id: chat }, 30_000, signal)
  } catch {
    // Already there.
  }
}

/** Hand one line to one agent. The line arrives attributed, exactly as a
 *  person's would: an agent has no way to tell whether the speaker was human.
 *
 *  A turn gets the same 240s whether or not a caller can cancel it. Deriving
 *  the budget from whether a signal was passed capped every reply at 30s, so an
 *  agent that used a tool for 40s was reported unavailable while its answer
 *  landed in its history unseen. Cancellation and budget are separate things;
 *  whoever needs a shorter budget puts it in the signal it passes. */
export async function deliver(agent: Agent, chat: string, speaker: string, text: string, signal?: AbortSignal): Promise<Reply> {
  try {
    const res = await post(agent, `/api/sessions/${chat}/chat`, {
      message: `${speaker}: ${text}`,
    }, 240_000, signal)
    const raw: string = res?.message?.content ?? ""
    if (SILENT.has(raw.trim()) || !raw.trim()) return { spoke: false }
    const { audio, text: said } = splitAudio(raw)
    return said ? { spoke: true, text: said, audio } : { spoke: false }
  } catch (err) {
    return { spoke: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Who is in the room, for the agents to be told. Without it an agent knows its
 *  own name and nothing else, so it cannot tell a question aimed at Jordan from
 *  one aimed at itself. */
export function roster(agents: Agent[], people: string[], you: string): string {
  const names = agents.map((a) => a.name)
  return (
    `In this chat: ${[...people, ...names].join(", ")}. You are ${you}. ` +
    "The others are members like you — when one of them answers, that is another " +
    "agent speaking, not you. Reply only when the message is for you.\n\n" +
    "Messages reach you prefixed with who said them. Do not write that prefix " +
    "yourself and never repeat the question: say only your reply, with no name " +
    "and no colon in front of it.\n\n" +
    // The room hears every line, so an unaddressed question belongs to nobody in
    // it. The name goes inside the sentence — which is not the prefix banned
    // above, and an agent given both rules at once has read the second as
    // forbidding the first.
    "When your reply asks a question, name who you are asking: \"what did you " +
    "have in mind, Anna?\". That name goes inside the sentence, not in front of it."
  )
}

/**
 * Who hears this line: everyone but whoever said it.
 *
 * Every line reaches every agent, whether a person or an agent said it. That is
 * what makes it a room, and each of them deciding for itself whether it was
 * meant is the whole demonstration — the same split the platform this layer
 * came from makes, where addressing decides whether an agent SPEAKS and never
 * whether it hears.
 *
 * Delivering only to the agents a reply names is faster, cheaper and quietly
 * wrong: an agent asked to pass a standup on handed it back to somebody who had
 * already gone, because it was never given her turn. Not a lapse in judgement,
 * a hole in what it was told.
 */
export function audienceFor(agents: Agent[], speaker: string): Agent[] {
  return agents.filter((a) => a.name !== speaker)
}


/**
 * What was already said in a room, read from one agent's session.
 *
 * Any of them will do: at the first hop every line reaches everybody, so each
 * agent's history holds the same room. What a `user` message carries is the
 * attributed line the client sent — "Anna: hello" — so the speaker is recovered
 * from the prefix rather than from who the API says wrote it.
 */
export async function history(agent: Agent, chat: string) {
  const res = await fetch(`${agent.url}/api/sessions/${chat}/messages`, {
    headers: { Authorization: `Bearer ${agent.key}` },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  })
  if (!res.ok) return []
  const data = await res.json()
  const messages: { role?: string; content?: string }[] =
    data.messages ?? data.data ?? []

  const lines: { speaker: string; text: string; spoken: boolean }[] = []
  for (const m of messages) {
    const raw = String(m.content ?? "")
    if (!raw.trim()) continue
    if (m.role === "assistant") {
      const { audio, text } = splitAudio(raw)
      // The room's own transcript already carries what the others said; this
      // agent's replies are the only thing its history adds that is speech.
      if (text && !SILENT.has(text.trim())) {
        lines.push({ speaker: agent.name, text, spoken: !!audio })
      }
      continue
    }
    // Only what somebody said. A session also holds the agent's own machinery
    // — `tool` results above all — and a memory write answering
    // `{"success": true, …}` is not a line in a room.
    if (m.role !== "user") continue
    const said = SPOKE.exec(raw)
    if (!said) continue
    const [, speaker, text] = said
    // The roster is machinery, not conversation.
    if (speaker === "System") continue
    lines.push({ speaker, text: text.trim(), spoken: false })
  }
  return lines
}

/**
 * Delete a room, from every agent that holds it.
 *
 * A room is not one thing to delete: it is the same session id opened on each
 * gateway, so it is gone only when all of them have dropped it. An agent that
 * missed the delete would keep answering into a room the list no longer shows,
 * and its copy would still be the one `history` reads.
 *
 * Returns how many took it, so the caller can tell "deleted" from "mostly
 * deleted" rather than reporting success for a room that is still half there.
 */
export async function forget(group: Agent[], chat: string): Promise<number> {
  const results = await Promise.all(
    group.map(async (agent) => {
      try {
        const res = await fetch(`${agent.url}/api/sessions/${chat}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${agent.key}` },
          signal: AbortSignal.timeout(10_000),
        })
        // A room an agent never had is a room it no longer has.
        return res.ok || res.status === 404
      } catch {
        return false
      }
    }),
  )
  return results.filter(Boolean).length
}
