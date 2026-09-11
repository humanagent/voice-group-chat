"use client"

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react"
import { CommitStrategy, Scribe } from "@elevenlabs/client"
import { Dictation, idleDictation, type DictationState } from "@/lib/dictation"
import { record, sampleFrames } from "@/lib/telemetry"

const EMPTY: readonly number[] = []

export function useDictation({ completed, failed, statusChanged }: {
  completed: (text: string) => void
  failed: (message: string, text: string) => void
  statusChanged: (status: DictationState["status"]) => void
}) {
  const [state, setState] = useState(idleDictation)
  const controller = useRef<Dictation | null>(null)
  const lastRenderMetric = useRef(-Infinity)
  const onCompleted = useEffectEvent(completed)
  const onFailed = useEffectEvent(failed)
  const onStatus = useEffectEvent(statusChanged)
  // Normal and counted prompts use the same recorder and diagnostics contract.
  useLayoutEffect(() => {
    const now = performance.now()
    if (state.receivedAt && now - lastRenderMetric.current >= 1000) {
      record("dictation_render", now - state.receivedAt, state.id)
      lastRenderMetric.current = now
    }
  }, [state.text, state.receivedAt, state.id])

  useEffect(() => {
    let mounted = true
    let status: DictationState["status"] = "idle"
    // What the server said about language when it minted the token, held for
    // the connect that follows it. A room that has picked a language says so
    // once, here, instead of letting every session guess again.
    let language: string | undefined
    // How loud is loud enough, decided by the room and shipped with the token.
    let gate = 0
    const dictation = new Dictation({
      token: async (signal, id) => {
        const response = await fetch("/api/scribe", { method: "POST", signal, headers: { "X-Request-ID": id } })
        if (!response.ok) throw new Error("Token unavailable")
        const data = await response.json()
        if (typeof data.token !== "string" || !data.token) throw new Error("Token unavailable")
        language = typeof data.language === "string" && data.language ? data.language : undefined
        gate = typeof data.gate === "number" && data.gate > 0 && data.gate < 1 ? data.gate : 0
        return data.token
      },
      gate: () => gate,
      connect: (token) => Scribe.connect({
        token, modelId: "scribe_v2_realtime", commitStrategy: CommitStrategy.MANUAL,
        ...(language ? { languageCode: language } : {}),
        // The server's half of the same idea. The gate above decides what
        // leaves the browser; this asks ElevenLabs to discount what it hears
        // from across the room — which here is three agents answering out loud
        // into the same microphone that is listening for the next question.
        filterBackgroundAudio: true,
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

  // Read on a frame loop rather than through state: loudness changes sixty
  // times a second and none of it is worth a re-render.
  const levels = useCallback(() => controller.current?.levels() ?? EMPTY, [])
  const gate = useCallback(() => controller.current?.gate() ?? 0, [])

  return { ...state, levels, gate, start: () => void controller.current?.start(), finish: () => controller.current?.finish(), cancel: () => controller.current?.cancel() }
}
