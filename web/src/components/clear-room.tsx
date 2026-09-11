"use client"

import { useLayoutEffect, useRef } from "react"
import { XIcon } from "lucide-react"
import { cycleDialogFocus } from "@/lib/dialog-focus"

/**
 * The one question worth interrupting somebody for.
 *
 * Clearing the room is not undoing a message. The transcript IS the context —
 * all three agents read the whole thing before deciding whether the last line
 * was theirs — so this deletes the conversation from three separate processes
 * and from every screen that has the room open, and nothing brings it back.
 *
 * The safe answer is the one under the cursor and the one in full ink. A
 * destructive action styled as the obvious default is how it gets pressed by
 * somebody who was answering a different question, so here the big button keeps
 * the conversation and the quiet one is the one that ends it, with the
 * consequence written on it rather than implied by its colour.
 */
export function ClearRoom({ clear, dismiss }: { clear: () => void; dismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const keep = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    keep.current?.focus({ preventScroll: true })
    return () => element.close()
  }, [])
  return <dialog
    ref={dialog}
    className="room-dialog clear-room"
    aria-labelledby="clear-room-title"
    aria-describedby="clear-room-what"
    onKeyDown={cycleDialogFocus}
    onCancel={(event) => { event.preventDefault(); dismiss() }}
  >
    <button className="icon-button result-close" aria-label="Close" onClick={dismiss}><XIcon size={18} /></button>
    <h2 id="clear-room-title">Clear the room?</h2>
    <p id="clear-room-what" className="clear-what">
      Every line goes, for everyone here, and all three agents forget the conversation.
      They keep who they are; your name and the board stay.
    </p>
    <button ref={keep} className="confirm-button" onClick={() => { dialog.current?.close(); dismiss() }}>Keep the conversation</button>
    <button className="result-again clear-confirm" onClick={() => { dialog.current?.close(); clear() }}>Clear it. This cannot be undone.</button>
  </dialog>
}
