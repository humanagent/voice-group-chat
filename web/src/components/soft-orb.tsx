import type { CSSProperties } from "react"
import { seedFor } from "@/lib/seed"
import { cn } from "@/lib/utils"

const palettes = [
  ["#ddd2ff", "#ad8cda", "#534468"],
  ["#ffe5c0", "#d69e7b", "#735050"],
  ["#d2f8e9", "#83bdb0", "#345d64"],
]
const familiar: Record<string, number> = { Steve: 0, Jordan: 1, Pepe: 2 }

/** Composited gradients keep the room alive without a WebGL context per agent. */
export function SoftOrb({ name, className, still = false }: { name: string; className?: string; still?: boolean }) {
  const seed = seedFor(name)
  const colors = palettes[familiar[name] ?? seed % palettes.length]
  return (
    <span aria-hidden="true" className={cn("soft-orb", still && "orb-still", className)} style={{
      "--orb-light": colors[0], "--orb-color": colors[1], "--orb-deep": colors[2],
      "--orb-duration": `${18 + seed % 9}s`, "--orb-delay": `${-(seed % 12)}s`,
    } as CSSProperties}>
      <span className="orb-cloud" /><span className="orb-gloss" />
    </span>
  )
}
