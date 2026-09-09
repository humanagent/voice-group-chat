"use client"

import { useEffect, useRef } from "react"
import type { AgentState } from "@/components/ui/orb"
import { SoftOrb } from "@/components/soft-orb"

export function Bubble({ name, agentState, className = "relative h-full w-full", getOutputVolume }: {
  name: string; agentState?: AgentState; live?: boolean; className?: string;
  volumeMode?: "manual"; getOutputVolume?: () => number
}) {
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (agentState !== "talking" || !getOutputVolume) return
    const media = matchMedia("(prefers-reduced-motion: reduce)")
    let frame = 0
    let smoothed = 0
    const tick = () => {
      smoothed += (getOutputVolume() - smoothed) * 0.12
      if (element.current) element.current.style.transform = `scale(${1 + smoothed * 0.12})`
      frame = requestAnimationFrame(tick)
    }
    const sync = () => {
      cancelAnimationFrame(frame)
      if (!document.hidden && !media.matches) frame = requestAnimationFrame(tick)
      else if (element.current) element.current.style.transform = ""
    }
    sync()
    document.addEventListener("visibilitychange", sync)
    media.addEventListener("change", sync)
    const node = element.current
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("visibilitychange", sync)
      media.removeEventListener("change", sync)
      if (node) node.style.transform = ""
    }
  }, [agentState, getOutputVolume])
  return <div ref={element} className={className}><SoftOrb name={name} still={agentState === null} className="size-full" /></div>
}
