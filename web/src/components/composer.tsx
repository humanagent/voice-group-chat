"use client"

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { ArrowUpIcon, LoaderCircleIcon, MicIcon, SquareIcon, XIcon } from "lucide-react"
import { useDictation } from "@/hooks/use-dictation"
import { getDraft, saveDraft, serverDraft, subscribeDraft } from "@/lib/draft"
import { worthSending } from "@/lib/listening"
import { record } from "@/lib/telemetry"
import type { DictationState } from "@/lib/dictation"

export type ComposerHandle = { restore: (text: string) => void }

export function Composer({ ready, online, busy, speech, submit, stop, handle, recordingChanged, reportError }: {
  ready: boolean; online: boolean; busy: boolean; speech: boolean;
  submit: (text: string) => boolean; stop: () => void;
  recordingChanged: (status: DictationState["status"]) => void; reportError: (message: string | null) => void;
  handle: React.RefObject<ComposerHandle | null>
}) {
  const { text: draft, saved } = useSyncExternalStore(subscribeDraft, getDraft, serverDraft)
  const box = useRef<HTMLTextAreaElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const lastRenderMetric = useRef(-Infinity)
  function restore(text: string) {
    if (!text.trim()) return
    const previous = getDraft().text
    saveDraft(previous ? `${previous}\n${text}` : text)
    requestAnimationFrame(() => box.current?.focus())
  }
  useImperativeHandle(handle, () => ({ restore }), [])
  const dictation = useDictation({
    statusChanged: recordingChanged,
    completed: (text) => {
      if (worthSending(text)) { if (!submit(text)) restore(text) }
      else reportError("No words came back. You can try recording again or keep typing.")
    },
    failed: (message, text) => { restore(text); reportError(message) },
  })
  const listening = dictation.status !== "idle"
  useLayoutEffect(() => {
    if (follow.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight
    const now = performance.now()
    if (dictation.receivedAt && now - lastRenderMetric.current >= 1000) {
      record("dictation_render", now - dictation.receivedAt, dictation.id)
      lastRenderMetric.current = now
    }
  }, [dictation.text, dictation.receivedAt, dictation.id])
  useEffect(() => {
    const node = box.current
    if (!node) return
    node.style.height = "auto"
    node.style.height = `${Math.min(node.scrollHeight, 144)}px`
  }, [draft, listening])
  function change(value: string) {
    saveDraft(value)
  }
  function send() {
    if (submit(draft.trim())) { change(""); box.current?.focus() }
  }
  return (
    <footer className="composer-wrap">
      <form className={`composer ${listening ? "is-recording" : ""}`} onSubmit={(event) => { event.preventDefault(); if (!listening) send() }}>
        {listening ? (
          <>
            <div className="recording-content">
              <MicIcon size={18} className="recording-icon" aria-hidden="true" />
              <div className="recording-transcript" ref={transcript} role="region" aria-label="Live transcription" tabIndex={0} onScroll={(event) => {
                const node = event.currentTarget
                follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
              }}><p>{dictation.text || (dictation.status === "connecting" ? "Connecting microphone…" : "Listening…")}</p></div>
            </div>
            <button type="button" className="icon-button" onClick={() => { dictation.cancel(); requestAnimationFrame(() => box.current?.focus()) }} aria-label="Discard recording"><XIcon size={18} /></button>
            <button type="button" className="send-button" onClick={dictation.finish} disabled={dictation.status !== "listening"} aria-label={dictation.status === "finishing" ? "Finishing transcription" : "Send recording"}>{dictation.status === "finishing" ? <LoaderCircleIcon size={20} className="animate-spin" /> : <ArrowUpIcon size={20} />}</button>
          </>
        ) : (
          <>
            <textarea ref={box} aria-label="Message the room" rows={1} maxLength={20000} value={draft} onChange={(event) => change(event.target.value)} placeholder="Type a message…" onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); send() }
            }} />
            <div className="composer-buttons">
              {busy && <button type="button" className="icon-button" onClick={stop} aria-label="Stop the room" title="Stop the room"><SquareIcon size={15} /></button>}
              <button type="button" className="icon-button" onClick={() => { stop(); reportError(null); follow.current = true; dictation.start() }} disabled={!speech || !online || !ready} aria-label="Record a voice message" title={speech ? "Record a voice message" : "Voice is not configured"}><MicIcon size={19} /></button>
              <button type="submit" className="send-button" disabled={!draft.trim() || !ready || !online} aria-label="Send message"><ArrowUpIcon size={20} /></button>
            </div>
          </>
        )}
      </form>
      {!saved && <p className="composer-hint" role="status">Draft storage unavailable</p>}
    </footer>
  )
}
