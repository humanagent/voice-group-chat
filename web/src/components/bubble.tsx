"use client"

import { useCallback, useState } from "react"

import { type AgentState, Orb } from "@/components/ui/orb"
import { SoftOrb } from "@/components/soft-orb"
import { seedFor } from "@/lib/seed"

/**
 * An agent on screen, with a floor under it.
 *
 * Two layers. `SoftOrb` is underneath and is always drawn — no GPU, no context,
 * nothing to lose — and the ElevenLabs orb fades in over it once it has
 * actually rendered a frame. If the browser takes the context back, and it
 * does, the canvas fades out and the drawing underneath is simply what you see.
 *
 * The point is that no state of the GPU produces an empty circle. Before this,
 * "Context Lost" three times over meant a stage with nobody standing on it,
 * which is the one screen this whole thing exists to show. It also means the
 * bubbles are on screen from the first paint rather than a second and a half
 * later, when the shader finally finishes compiling.
 */
export function Bubble({
  name,
  agentState,
  live = true,
  className = "relative h-full w-full",
  ...orb
}: {
  name: string
  agentState?: AgentState
  /** Whether to spend a WebGL context here at all. They are capped, and at the
   *  size of a message avatar there is no shader detail to see. */
  live?: boolean
  className?: string
  volumeMode?: "manual"
  getOutputVolume?: () => number
}) {
  const [painted, setPainted] = useState(false)
  const onPainted = useCallback((ok: boolean) => setPainted(ok), [])

  return (
    <div className={className}>
      <SoftOrb
        name={name}
        still={agentState === null}
        className="absolute inset-0 h-full w-full"
      />
      {live && (
        <div
          className="absolute inset-0 transition-opacity duration-500"
          style={{ opacity: painted ? 1 : 0 }}
        >
          <Orb seed={seedFor(name)} agentState={agentState} onPainted={onPainted} {...orb} />
        </div>
      )}
    </div>
  )
}
