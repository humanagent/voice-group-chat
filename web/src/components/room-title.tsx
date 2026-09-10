"use client"

import { useRef, useState } from "react"
import { playerName, refusal } from "@/lib/player"

/**
 * The room belongs to whoever is playing, and they say so by typing it.
 *
 * The title IS the field, rather than a heading with a pencil beside it or a
 * settings sheet behind a gear: one thing on screen, and the thing you edit is
 * the thing you read. The name is set in full ink and the possessive trails it a
 * tonal step quieter, so the eye lands on the part that is yours to change
 * without any ornament saying so.
 *
 * The name on screen is a span, with the input laid over it and only inked while
 * it has focus. The span is what carries the width, and it is also the reason a
 * name too long for a phone ends in an ellipsis instead of being sliced through
 * the middle of a letter — an input cannot do that, and a clipped name reads as
 * broken rather than shortened. Measuring the twin in JavaScript and assigning the
 * width was the obvious version and it was wrong twice over: the field is a flex
 * item, so an input at `width: 100%` inside it sizes from a box that is sizing
 * from the input, and the first paint happens before any measurement exists. In
 * flow there is no circle and no first frame to get wrong — the box is the text,
 * and the field grows as it is typed with nothing to synchronise.
 */
export function RoomTitle({ name, agents, rename }: {
  name: string
  agents: readonly string[]
  rename: (name: string) => void
}) {
  const [draft, setDraft] = useState(name)
  const [problem, setProblem] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)

  // A rename from anywhere else — the scoreboard claiming it, a cleared name —
  // is the truth, and the field follows it. Adjusted during render rather than
  // in an effect so the input never paints one frame of the stale name.
  const [known, setKnown] = useState(name)
  if (name !== known) { setKnown(name); setDraft(name); setProblem(null) }

  function commit() {
    const typed = draft.trim()
    // Emptying it gives the room back its plain name. That is a decision, not a
    // mistake, so it is never refused.
    if (!typed) { setProblem(null); setDraft(""); rename(""); return }
    const valid = playerName(typed, agents)
    // A refused name stays in the field. Reverting it silently would look like
    // the keystrokes were lost, and the person cannot fix what they cannot see.
    if (!valid) { setProblem(refusal(typed, agents)); return }
    setProblem(null)
    setDraft(valid)
    rename(valid)
  }

  return (
    <>
      <h1
        className="room-title"
        aria-label={name ? `${name}’s room` : "The room"}
        onMouseDown={(event) => {
          // Anywhere but the field itself: hand the caret to the name rather
          // than letting a click on "’s room" land on nothing.
          if (event.target instanceof HTMLInputElement) return
          event.preventDefault()
          field.current?.focus()
        }}
      >
        <span className="room-name-field">
          <input
            ref={field}
            className="room-name"
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setProblem(null) }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur() }
              if (event.key === "Escape") { setDraft(name); setProblem(null); event.currentTarget.blur() }
            }}
            maxLength={24}
            placeholder="Your name"
            // Not "Your name", and not a phrase containing it either: the
            // scoreboard asks for a name too, and anything reaching a control
            // by its words — a screen reader, voice control, a test — then has
            // two answers. This says what the field is actually for.
            aria-label="Who is playing"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? "room-name-problem" : undefined}
            autoComplete="nickname"
            spellCheck={false}
            enterKeyHint="done"
          />
          <span className={`room-name-shown${draft ? "" : " room-name-empty"}`} aria-hidden="true">{draft || "Your name"}</span>
        </span>
        <span className="room-title-tail">’s room</span>
      </h1>
      {problem && <p className="room-name-problem" id="room-name-problem" role="alert">{problem}</p>}
    </>
  )
}
