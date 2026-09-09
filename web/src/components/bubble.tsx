"use client"

import { useEffect, useRef } from "react"
import { SoftOrb } from "@/components/soft-orb"
import { easeLevel, visualLoop } from "@/lib/visual-motion"

type AgentState = null | "thinking" | "listening" | "talking"

export function Bubble({ name, agentState, className = "relative h-full w-full", getOutputVolume }: {
  name: string; agentState?: AgentState; className?: string; getOutputVolume?: () => number
}) {
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (agentState !== "talking" || !getOutputVolume) return
    let smoothed = 0
    const node = element.current
    const rest = () => { smoothed = 0; if (node) node.style.transform = "" }
    const stop = visualLoop((_, elapsed) => {
      smoothed = easeLevel(smoothed, getOutputVolume(), elapsed)
      if (node) node.style.transform = `scale(${1 + smoothed * 0.12})`
    }, rest)
    return () => {
      stop()
      rest()
    }
  }, [agentState, getOutputVolume])
  return <div ref={element} className={className}><SoftOrb name={name} still={agentState === null} className="size-full" /></div>
}
