"use client"

import { useEffect, useRef } from "react"
import { visualLoop } from "@/lib/visual-motion"

/** Bars on screen. The meter holds more than this; the row shows its tail. */
const BARS = 32
const FLOOR = 2
const CEILING = 24

/**
 * What the microphone is hearing, and nothing else.
 *
 * The words used to stream into the composer as they were guessed, which meant
 * watching a sentence rewrite itself while trying to say the next one. The
 * waveform answers the only question that matters mid-sentence — is it hearing
 * me — and the words arrive when the sentence is finished.
 *
 * Height, never `scaleY`: these bars are pills, and scaling one flattens its
 * round caps into ellipses on the way up. The row is also written straight to
 * the DOM on each frame rather than through state, because sixty re-renders a
 * second to move a few pixels is a cost with nothing to show for it.
 */
export function Waveform({ levels }: { levels: () => readonly number[] }) {
  const row = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bars = [...(row.current?.children ?? [])] as HTMLElement[]
    const paint = (heights: number[]) => bars.forEach((bar, i) => { bar.style.height = `${heights[i]}px` })
    const flat = () => paint(bars.map(() => FLOOR))
    return visualLoop(() => {
      const recent = levels()
      const tail = recent.slice(-BARS)
      paint(bars.map((_, i) => {
        const value = tail[i - (BARS - tail.length)] ?? 0
        // A voice sits low in a linear scale and a loud room fills it; the
        // curve gives ordinary speech most of the height it has.
        const scaled = Math.min(1, Math.sqrt(value) * 2.6)
        return Math.round(FLOOR + scaled * (CEILING - FLOOR))
      }))
    }, flat)
  }, [levels])

  return (
    <div className="waveform" ref={row} aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => <i key={i} style={{ height: FLOOR }} />)}
    </div>
  )
}
