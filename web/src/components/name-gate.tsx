"use client"

import { useLayoutEffect, useRef, useState } from "react"
import { XIcon } from "lucide-react"
import { useKeyboardFocus } from "@/hooks/use-keyboard-focus"
import { cycleDialogFocus } from "@/lib/dialog-focus"
import { playerName, refusal } from "@/lib/player"

/**
 * The first thing the room asks, and the last time it asks.
 *
 * The name was already the price of sending a line — the composer refuses
 * without one — but the only thing that said so was a placeholder in a title
 * that reads as a heading. Somebody arriving for the first time saw a disabled
 * send button and no reason for it. So the question comes first, in the open,
 * with the reason attached: the agents read the name on the line, and it is how
 * they know which question is yours to answer.
 *
 * Asked once. From here the name is the room's, the transcript's, the prefix
 * every agent reads and the one the scoreboard publishes, so no later screen
 * has any excuse to ask for it a second time.
 *
 * Closable, never a trap. Closing it leaves exactly the room that existed
 * before this dialog did: the title is still a field, and the composer still
 * says what it is waiting for.
 */
export function NameGate({ agents, claim, dismiss }: {
  agents: readonly string[]
  claim: (name: string) => void
  dismiss: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const keyboardFocus = useKeyboardFocus<HTMLInputElement>()
  const [draft, setDraft] = useState("")
  const [problem, setProblem] = useState<string | null>(null)

  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    // The field is the whole dialog. Focus it without scrolling: the room
    // behind is a fixed surface and must not move under the keyboard.
    field.current?.focus({ preventScroll: true })
    return () => element.close()
  }, [])

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const typed = draft.trim()
    const claimed = playerName(typed, agents)
    // A refused name stays in the field with the reason under it — taking Anna
    // is the common one, and "Anna is already in the room" is the only answer
    // that tells the person what to type instead.
    if (!claimed) { setProblem(refusal(typed, agents) ?? "Letters, numbers and spaces."); return }
    dialog.current?.close()
    claim(claimed)
  }

  // Written out rather than joined with commas alone: these are the three
  // voices in this particular room, and naming them is the point of the ask.
  const room = agents.length > 1 ? `${agents.slice(0, -1).join(", ")} and ${agents.at(-1)}` : agents[0] ?? "The agents"

  return <dialog
    ref={dialog}
    className="room-dialog name-gate"
    aria-labelledby="name-gate-title"
    aria-describedby="name-gate-why"
    onKeyDown={cycleDialogFocus}
    onCancel={(event) => { event.preventDefault(); dismiss() }}
  >
    <button className="icon-button result-close" aria-label="Close" onClick={dismiss}><XIcon size={18} /></button>
    <h2 id="name-gate-title">Who’s playing?</h2>
    <p className="gate-why" id="name-gate-why">{room} read the name on every line. Yours is how they know a question is for you, and what they call you when they answer.</p>
    <form onSubmit={submit}>
      <label htmlFor="player-name">Your name</label>
      <input
        {...keyboardFocus}
        ref={field}
        id="player-name"
        value={draft}
        onChange={(event) => { setDraft(event.target.value); setProblem(null) }}
        maxLength={24}
        autoComplete="nickname"
        spellCheck={false}
        enterKeyHint="done"
        required
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? "player-name-problem" : undefined}
      />
      {problem && <p id="player-name-problem" role="alert">{problem}</p>}
      <button className="confirm-button" disabled={!draft.trim()}>Enter the room</button>
    </form>
    <p>Scores go on the public board under this name.</p>
  </dialog>
}
