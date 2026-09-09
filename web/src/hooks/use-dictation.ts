"use client"

import { useEffect, useEffectEvent, useRef, useState } from "react"
import { CommitStrategy, Scribe } from "@elevenlabs/client"
import { Dictation, idleDictation, type DictationState } from "@/lib/dictation"
import { record, sampleFrames } from "@/lib/telemetry"

export function useDictation({ completed, failed, statusChanged }: {
  completed: (text: string) => void
  failed: (message: string, text: string) => void
  statusChanged: (status: DictationState["status"]) => void
}) {
  const [state, setState] = useState(idleDictation)
  const controller = useRef<Dictation | null>(null)
  const onCompleted = useEffectEvent(completed)
  const onFailed = useEffectEvent(failed)
  const onStatus = useEffectEvent(statusChanged)

  useEffect(() => {
    let mounted = true
    let status: DictationState["status"] = "idle"
    const dictation = new Dictation({
      token: async (signal, id) => {
        const response = await fetch("/api/scribe", { method: "POST", signal, headers: { "X-Request-ID": id } })
        if (!response.ok) throw new Error("Token unavailable")
        const data = await response.json()
        if (typeof data.token !== "string" || !data.token) throw new Error("Token unavailable")
        return data.token
      },
      connect: (token) => Scribe.connect({
        token, modelId: "scribe_v2_realtime", commitStrategy: CommitStrategy.MANUAL,
        microphone: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }),
      changed: (next) => {
        if (!mounted) return
        setState(next)
        if (next.status !== status) { status = next.status; onStatus(status) }
        if (next.receivedAt) sampleFrames()
      },
      completed: (text) => { if (mounted) onCompleted(text) },
      failed: (message, text) => { if (mounted) onFailed(message, text) },
      metric: record,
    })
    controller.current = dictation
    return () => { mounted = false; dictation.cancel(); controller.current = null }
  }, [])

  return { ...state, start: () => void controller.current?.start(), finish: () => controller.current?.finish(), cancel: () => controller.current?.cancel() }
}
