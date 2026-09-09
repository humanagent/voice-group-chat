"use client"

import { useLayoutEffect, useRef } from "react"
import { PlayIcon, TrophyIcon, XIcon } from "lucide-react"
import { CHALLENGE_TARGET } from "@/lib/challenge"
import { cycleDialogFocus } from "@/lib/dialog-focus"

/** Rules only. Play hands off to the existing composer, never another recorder. */
export function ChallengeIntro({ ready, play, dismiss }: { ready: boolean; play: () => void; dismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const playButton = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    playButton.current?.focus({ preventScroll: true })
    return () => element.close()
  }, [])
  return <dialog ref={dialog} className="challenge-result challenge-intro" aria-labelledby="challenge-intro-title" aria-describedby="challenge-intro-rules" onKeyDown={cycleDialogFocus} onCancel={(event) => { event.preventDefault(); dismiss() }}>
    <button className="icon-button result-close" aria-label="Close challenge" onClick={dismiss}><XIcon size={18} /></button>
    <div className="result-trophy"><TrophyIcon size={32} strokeWidth={1.5} aria-hidden="true" /></div>
    <h2 id="challenge-intro-title">Keep them talking</h2>
    <p className="result-score" aria-label={`0 of ${CHALLENGE_TARGET} replies`}>0<span>/{CHALLENGE_TARGET}</span></p>
    <p id="challenge-intro-rules">One prompt. Get the agents talking to each other.<br />Reach {CHALLENGE_TARGET} replies to win.</p>
    <p>Ask a question. Spark a debate. See how far it goes.</p>
    <button ref={playButton} className="confirm-button intro-play" disabled={!ready} onClick={() => { dialog.current?.close(); play() }}><PlayIcon size={18} aria-hidden="true" />Play</button>
    <p>Your microphone starts when you press Play.</p>
  </dialog>
}
