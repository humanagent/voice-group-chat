"use client"

import { useEffect, useImperativeHandle, useRef, useSyncExternalStore } from "react"
import { ArrowUpIcon, MicIcon, SquareIcon, XIcon } from "lucide-react"
import { LiveWaveform } from "@/components/ui/live-waveform"
import { getDraft, saveDraft, serverDraft, subscribeDraft } from "@/lib/draft"

export type ComposerHandle = { restore: (text: string) => void }

export function Composer({ ready, online, busy, speech, connecting, listening, heard, submit, listen, sendRecording, discard, stop, handle }: {
  ready: boolean; online: boolean; busy: boolean; speech: boolean; connecting: boolean;
  listening: boolean; heard: string; submit: (text: string) => boolean; listen: () => void;
  sendRecording: () => void; discard: () => void; stop: () => void;
  handle: React.RefObject<ComposerHandle | null>
}) {
  const { text: draft, saved } = useSyncExternalStore(subscribeDraft, getDraft, serverDraft)
  const box = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(handle, () => ({ restore: (text) => {
      const previous = getDraft().text
      saveDraft(previous ? `${previous}\n${text}` : text)
      box.current?.focus()
    } }), [])
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
      <form className={`composer ${listening ? "is-recording" : ""}`} onSubmit={(event) => { event.preventDefault(); send() }}>
        {listening ? (
          <>
            <div className="recording-content"><LiveWaveform active height={30} barWidth={3} barGap={2} className="w-16 shrink-0" /><p>{heard || "Listening…"}</p></div>
            <button type="button" className="icon-button" onClick={discard} aria-label="Discard recording"><XIcon size={18} /></button>
            <button type="button" className="send-button" onClick={sendRecording} aria-label="Send recording"><ArrowUpIcon size={20} /></button>
          </>
        ) : (
          <>
            <textarea ref={box} aria-label="Message the room" rows={1} maxLength={20000} value={draft} onChange={(event) => change(event.target.value)} placeholder="Type a message…" onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); send() }
            }} />
            <div className="composer-buttons">
              {busy && <button type="button" className="icon-button" onClick={stop} aria-label="Stop the room" title="Stop the room"><SquareIcon size={15} /></button>}
              <button type="button" className={`icon-button ${connecting ? "animate-pulse" : ""}`} onClick={listen} disabled={!speech || !online || !ready || connecting} aria-label={connecting ? "Connecting microphone" : "Record a voice message"} title={speech ? "Record a voice message" : "Voice is not configured"}><MicIcon size={19} /></button>
              <button type="submit" className="send-button" disabled={!draft.trim() || !ready || !online} aria-label="Send message"><ArrowUpIcon size={20} /></button>
            </div>
          </>
        )}
      </form>
      {!saved && <p className="composer-hint" role="status">Draft storage unavailable</p>}
    </footer>
  )
}
