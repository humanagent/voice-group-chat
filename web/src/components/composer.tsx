"use client"

import { useImperativeHandle, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { ArrowUpIcon, LoaderCircleIcon, MicIcon, SquareIcon, XIcon } from "lucide-react"
import { useDictation } from "@/hooks/use-dictation"
import { Waveform } from "@/components/waveform"
import { useKeyboardFocus } from "@/hooks/use-keyboard-focus"
import { getDraft, saveDraft, serverDraft, subscribeDraft } from "@/lib/draft"
import { worthSending } from "@/lib/listening"
import type { DictationState } from "@/lib/dictation"

export type ComposerHandle = { restore: (text: string) => void; startRecording: () => boolean }

const noSubscription = () => () => {}

export function Composer({ ready, online, busy, speech, submit, stop, handle, recordingChanged, reportError, promptLimit = 20000, placeholder = "Type a message…" }: {
  ready: boolean; online: boolean; busy: boolean; speech: boolean;
  submit: (text: string) => boolean; stop: () => void;
  recordingChanged: (status: DictationState["status"]) => void; reportError: (message: string | null) => void;
  handle: React.RefObject<ComposerHandle | null>
  promptLimit?: number; placeholder?: string
}) {
  // Server HTML has no input handlers. Enable only after hydration, not after
  // the gateway connects: drafts must stay editable while connecting/offline.
  const interactive = useSyncExternalStore(noSubscription, () => true, () => false)
  const { text: draft, saved } = useSyncExternalStore(subscribeDraft, getDraft, serverDraft)
  const box = useRef<HTMLTextAreaElement>(null)
  const keyboardFocus = useKeyboardFocus<HTMLTextAreaElement>()
  function restore(text: string) {
    if (!text.trim()) return
    const previous = getDraft().text
    saveDraft(previous ? `${previous}\n${text}` : text)
    requestAnimationFrame(() => box.current?.focus({ preventScroll: true }))
  }
  const dictation = useDictation({
    statusChanged: recordingChanged,
    completed: (text) => {
      if (text.length > promptLimit) { restore(text); reportError(`Your prompt is too long. Shorten it to ${promptLimit.toLocaleString()} characters before sending.`) }
      else if (worthSending(text)) { if (!submit(text)) restore(text) }
      else reportError("No words came back. You can try recording again or keep typing.")
    },
    failed: (message, text) => { restore(text); reportError(message) },
  })
  const listening = dictation.status !== "idle"
  function startRecording() {
    if (!speech || !online || !ready || listening) return false
    stop()
    reportError(null)
    dictation.start()
    return true
  }
  // Challenge/Play is a shortcut to this exact microphone, not a second recorder.
  useImperativeHandle(handle, () => ({ restore, startRecording }))
  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    node.style.height = "auto"
    node.style.height = `${Math.min(node.scrollHeight, 144)}px`
  }, [draft, listening])
  function change(value: string) {
    saveDraft(value)
  }
  function send() {
    if (submit(draft.trim())) { change(""); box.current?.focus({ preventScroll: true }) }
  }
  return (
    <footer className="composer-wrap">
      <form className={`composer ${listening ? "is-recording" : ""}`} onPointerDown={(event) => {
        // The visible input includes its padded surface. Tapping that surface
        // must not blur the textarea; buttons keep their own focus behavior.
        if (event.target === event.currentTarget && box.current) {
          event.preventDefault()
          box.current.focus({ preventScroll: true })
        }
      }} onSubmit={(event) => { event.preventDefault(); if (!listening) send() }}>
        {listening ? (
          <>
            <div className="recording-content">
              <MicIcon size={18} className="recording-icon" aria-hidden="true" />
              {dictation.status === "listening"
                ? <Waveform levels={dictation.levels} />
                : <p className="recording-note">{dictation.status === "connecting" ? "Connecting microphone…" : "Finishing transcription…"}</p>}
              {/* The words are no longer on screen while they are still being
                  guessed — a sentence rewriting itself is impossible to talk
                  over. They stay here for anyone reading the room by name
                  rather than by sight, to whom a waveform says nothing. */}
              <p className="sr-only" role="region" aria-label="Live transcription">{dictation.text || (dictation.status === "connecting" ? "Connecting microphone…" : "Listening…")}</p>
            </div>
            <button type="button" className="icon-button" onClick={() => { dictation.cancel(); requestAnimationFrame(() => box.current?.focus({ preventScroll: true })) }} aria-label="Discard recording"><XIcon size={18} /></button>
            <button type="button" className="send-button" onClick={dictation.finish} disabled={dictation.status !== "listening"} aria-label={dictation.status === "finishing" ? "Finishing transcription" : "Send recording"}>{dictation.status === "finishing" ? <LoaderCircleIcon size={20} className="animate-spin" /> : <ArrowUpIcon size={20} />}</button>
          </>
        ) : (
          <>
            <textarea ref={box} {...keyboardFocus} aria-label="Message the room" rows={1} maxLength={promptLimit} disabled={!interactive} value={draft} onChange={(event) => change(event.target.value)} placeholder={interactive ? placeholder : "Loading…"} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); send() }
            }} />
            <div className="composer-buttons">
              {busy && <button type="button" className="icon-button" onClick={stop} aria-label="Stop the room" title="Stop the room"><SquareIcon size={15} /></button>}
              <button type="button" className="icon-button" onClick={startRecording} disabled={!speech || !online || !ready} aria-label="Record a voice message" title={speech ? "Record a voice message" : "Voice is not configured"}><MicIcon size={19} /></button>
              <button type="submit" className="send-button" disabled={!draft.trim() || !ready || !online} aria-label="Send message"><ArrowUpIcon size={20} /></button>
            </div>
          </>
        )}
      </form>
      {!saved && <p className="composer-hint" role="status">Draft storage unavailable</p>}
    </footer>
  )
}
