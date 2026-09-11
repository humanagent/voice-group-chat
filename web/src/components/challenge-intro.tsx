"use client"

import { useLayoutEffect, useRef } from "react"
import { PlayIcon, TrophyIcon, XIcon } from "lucide-react"
import { cycleDialogFocus } from "@/lib/dialog-focus"

/** Rules only. Play hands off to the existing composer, never another recorder. */
export function ChallengeIntro({ ready, player, play, dismiss }: { ready: boolean; player: string; play: () => void; dismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const playButton = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    playButton.current?.focus({ preventScroll: true })
    return () => element.close()
  }, [])
  return <dialog ref={dialog} className="room-dialog challenge-intro" aria-labelledby="challenge-intro-title" aria-describedby="challenge-intro-rules" onKeyDown={cycleDialogFocus} onCancel={(event) => { event.preventDefault(); dismiss() }}>
    <button className="icon-button result-close" aria-label="Close challenge" onClick={dismiss}><XIcon size={18} /></button>
    <div className="result-trophy"><TrophyIcon size={32} strokeWidth={1.5} aria-hidden="true" /></div>
    <h2 id="challenge-intro-title">Keep them talking</h2>
    <p className="result-score" aria-label="0 replies">0<span>replies</span></p>
    <p id="challenge-intro-rules">One prompt. Every reply they give each other is a point.<br />No target: see how far the room gets.</p>
    <button ref={playButton} className="confirm-button" disabled={!ready} onClick={() => { dialog.current?.close(); play() }}><PlayIcon size={18} aria-hidden="true" />Play</button>
    {/* Both consequences of the button, in the order they happen: the
        microphone opens now, and the score goes on the public board at the end
        under the name already given. Said here so the end of a round has
        nothing left to ask. */}
    <p>The counter starts and your microphone opens on Play.{player && <> The score is published as <b>{player}</b>.</>}</p>
  </dialog>
}
