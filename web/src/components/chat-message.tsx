"use client"

import { memo, useEffect, useState } from "react"
import { CheckIcon, CopyIcon, CornerUpLeftIcon, Volume2Icon } from "lucide-react"
import { SoftOrb } from "@/components/soft-orb"
import { Response } from "@/components/ui/response"
import { upTo, type Position } from "@/lib/speaking"

export type Line = {
  id: string; speaker: string; text: string; spoken: boolean; animate?: boolean;
  delivery?: "queued" | "sending" | "sent" | "uncertain" | "not-sent" | "interrupted"
}

const deliveryLabels = { queued: "Queued", sending: "Sending", sent: "Sent", uncertain: "Connection interrupted · may have been received", "not-sent": "Not sent", interrupted: "Interrupted" }

function Reading({ text, live, where, speaker }: { text: string; live: boolean; speaker: string; where: () => Position | null }) {
  const [cut, setCut] = useState(text.length)
  const markdown = /(^|\n)\s*([#>|*-]|\d+\.)|[*_`\[]/.test(text)
  useEffect(() => {
    if (!live || markdown || matchMedia("(prefers-reduced-motion: reduce)").matches) return
    let frame = 0
    let last = 0
    const follow = (time: number) => {
      if (time - last > 32 && !document.hidden) {
        const at = where()
        setCut(at && at.agent === speaker ? upTo(text, at.said, at.spoken) : text.length)
        last = time
      }
      frame = requestAnimationFrame(follow)
    }
    frame = requestAnimationFrame(follow)
    return () => cancelAnimationFrame(frame)
  }, [text, speaker, live, where, markdown])
  if (markdown) return <Response>{text}</Response>
  const end = live ? cut : text.length
  return <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text.slice(0, end)}<span className="reading-ahead">{text.slice(end)}</span></p>
}

export const ChatMessage = memo(function ChatMessage({ line, live, where, restore }: { line: Line; live: boolean; where: () => Position | null; restore: (text: string) => void }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])
  async function copy() {
    try { await navigator.clipboard.writeText(line.text); setCopied(true); setCopyFailed(false) }
    catch { setCopyFailed(true) }
  }
  const you = line.speaker === "you"
  return (
    <article className={`chat-message ${you ? "from-you" : "from-agent"} ${line.animate ? "message-enter" : ""}`} aria-label={`${you ? "You" : line.speaker} said`}>
      {!you && <SoftOrb name={line.speaker} still className="message-avatar" />}
      <div className="message-body">
        <div className="message-meta"><span>{you ? "You" : line.speaker}</span>{!you && line.spoken && <span className="spoken-label"><Volume2Icon size={11} />{live ? "Speaking" : "Voice"}</span>}</div>
        <div className="message-bubble" data-speaking={live}>
          {you ? <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{line.text}</p> : <Reading text={line.text} speaker={line.speaker} live={live} where={where} />}
        </div>
        <div className="message-foot">
          {you && line.delivery && <span role={line.delivery === "uncertain" ? "status" : undefined}>{deliveryLabels[line.delivery]}</span>}
          {you && (line.delivery === "not-sent" || line.delivery === "uncertain") && <button onClick={() => restore(line.text)} aria-label="Use message as draft"><CornerUpLeftIcon size={12} /> Use as draft</button>}
          {!you && <button onClick={copy} aria-label={`Copy message from ${line.speaker}`}>{copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}{copied ? "Copied" : copyFailed ? "Couldn’t copy" : "Copy"}</button>}
        </div>
      </div>
    </article>
  )
})
