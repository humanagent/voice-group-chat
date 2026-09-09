"use client"

import { memo } from "react"
import { Bubble } from "@/components/bubble"

export type Phase = "listening" | "thinking" | "quiet" | "speaking" | "unreachable"
const captions: Record<Phase, string> = { listening: "Listening", thinking: "Thinking", quiet: "Listening", speaking: "Speaking", unreachable: "Unavailable" }

export const Stage = memo(function Stage({ names, phase, level }: { names: string[]; phase: Record<string, Phase>; level: () => number }) {
  return (
    <div className="agent-stage" aria-label="Agents in the room">
      {names.map((name, index) => {
        const state = phase[name] ?? "listening"
        return (
          <figure className="agent" data-phase={state} key={name} style={{ animationDelay: `${index * -1.8}s` }}>
            <div className="agent-orbit">
              <div className="agent-halo" />
              <div className="agent-sphere">
                <Bubble name={name} agentState={state === "speaking" ? "talking" : state === "thinking" ? "thinking" : state === "quiet" || state === "unreachable" ? null : "listening"} getOutputVolume={state === "speaking" ? level : undefined} />
              </div>
            </div>
            <figcaption><span className="agent-name">{name}</span><span className="agent-caption">{state === "speaking" && <span className="voice-bars" aria-hidden="true"><i /><i /><i /></span>}{captions[state]}</span></figcaption>
          </figure>
        )
      })}
    </div>
  )
})
