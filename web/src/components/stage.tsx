"use client"

import { useEffect, useRef, useState } from "react"
import { motion } from "motion/react"

import { Bubble } from "@/components/bubble"
import { type AgentState } from "@/components/ui/orb"

export type Phase = "listening" | "thinking" | "quiet" | "speaking" | "unreachable"

/** The orb has no "quiet": it goes still, which is exactly what quiet is. */
const ORB: Record<Phase, AgentState> = {
  listening: "listening",
  thinking: "thinking",
  quiet: null,
  speaking: "talking",
  unreachable: null,
}

/** The geometry, in pixels, so every position below is arithmetic rather than a
 *  layout engine's opinion. */
const REST = 96 // a bubble at rest
/** What the one that is talking grows to, when there is room for it. */
const BIG_MAX = 228
/** Two lines of caption, so the circle can be sized to leave room for them. */
const CAPTION_H = 38
/** Between a circle and its name, in screen pixels at any size. */
const LABEL_GAP = 14
/** Less than 1 and they overlap. Wide enough that each still has room for its
 *  own name underneath — a caption that collides with its neighbour's is worse
 *  than a little less overlap. */
const OVERLAP = 0.78
/** What a caption needs. The spacing above is checked against it. */
const CAPTION = 72
/** How far the others stand off when one has grown, measured from the big one's
 *  edge so it never lands on top of them. */
const CLEARANCE = 26

/**
 * Where each bubble sits, exactly.
 *
 * At rest they are a cluster centred on zero: evenly spaced at less than their
 * own width, so they overlap the way things floating together do. `(i - mid)`
 * is what centres them — for three that is -1, 0, +1, and for four -1.5 … +1.5,
 * with no special case for odd and even.
 *
 * When somebody is talking the cluster opens: the speaker goes to the middle and
 * the rest are pushed just clear of its edge — `BIG / 2 + REST / 2 + CLEARANCE`,
 * measured rather than guessed, so the big one never lands on top of them. The
 * waiting ones keep their own left-to-right order, so the cluster opens instead
 * of shuffling.
 */
function positions(names: string[], speaker: string | null, big: number) {
  const mid = (names.length - 1) / 2
  const step = REST * OVERLAP

  return names.map((name, i) => {
    if (!speaker) return { name, x: (i - mid) * step, size: REST, z: 1 }
    if (name === speaker) return { name, x: 0, size: big, z: 10 }

    // Rank among the ones still waiting, so two on the left do not stack.
    const others = names.filter((n) => n !== speaker)
    const at = others.indexOf(name)
    const half = (others.length - 1) / 2
    const side = at < half ? -1 : at > half ? 1 : 0
    const from = Math.abs(at - half)
    const clear = big / 2 + REST / 2 + CLEARANCE
    return { name, x: side * (clear + (from - 0.5) * step), size: REST * 0.82, z: 1 }
  })
}

/** Weight, not springiness. A bubble this size arriving with a bounce reads as
 *  a UI element popping; these should feel like they have some mass. */
const GRAVITY = { type: "spring", stiffness: 90, damping: 20, mass: 1.2 } as const

/**
 * The room, as bubbles.
 *
 * They float and turn constantly, each on its own clock so the cluster never
 * pulses in lockstep. Whoever is talking grows into the middle and the rest
 * make room; when the voice stops it settles back. Never more than one — the
 * harness runs a round where each agent decides independently and one line is
 * spoken at a time, so this draws the state of the conversation rather than
 * enforcing a rule of its own.
 */
export function Stage({
  names,
  phase,
  level,
}: {
  names: string[]
  phase: Record<string, Phase>
  level: () => number
}) {
  const stage = useRef<HTMLDivElement>(null)
  const [big, setBig] = useState(BIG_MAX)

  // How big the speaker can get is whatever fits, measured — not a number that
  // happened to work at one window size. The circle plus its name has to stay
  // inside the top half, so the radius is bounded by the half-height less what
  // the caption needs.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const fit = () => {
      const room = el.clientHeight / 2 - LABEL_GAP - CAPTION_H
      setBig(Math.max(REST, Math.min(BIG_MAX, room * 2)))
    }
    fit()
    const watch = new ResizeObserver(fit)
    watch.observe(el)
    return () => watch.disconnect()
  }, [])

  const speaker = names.find((n) => phase[n] === "speaking") ?? null
  const placed = positions(names, speaker, big)

  return (
    <div ref={stage} className="relative flex min-h-0 w-full flex-1 items-center justify-center">
      {placed.map(({ name, x, size, z }, i) => (
        // One wrapper per agent, pinned to the exact centre of the stage and
        // moved from there. Nothing here is centred by flow: the cluster would
        // land wherever the widths happened to add up to.
        <motion.div
          key={name}
          className="absolute top-1/2 left-1/2"
          style={{ zIndex: z }}
          animate={{ x }}
          transition={GRAVITY}
        >
          {/* A transform, not a size. Animating width and height relayouts on
              every frame and makes the canvas re-render in steps, which is what
              the growing looked like; a scale is one GPU composite. Safe now
              that the canvas measures with offsetSize and ignores it. */}
          <motion.div
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ width: REST, height: REST }}
            animate={{ scale: size / REST }}
            transition={GRAVITY}
          >
            <motion.div
              className="size-full"
              animate={{ y: [0, -9, 0, 7, 0] }}
              transition={{ duration: 7 + i * 1.6, repeat: Infinity, ease: "easeInOut" }}
            >
              <Bubble
                name={name}
                agentState={ORB[phase[name] ?? "listening"]}
                {...(name === speaker
                  ? { volumeMode: "manual" as const, getOutputVolume: level }
                  : {})}
              />
            </motion.div>
          </motion.div>

          {/* The name sits OUTSIDE what scales, and is pushed down by the
              circle's rendered radius. Riding along inside the scale is how the
              speaker's caption ended up three times the size and halfway into
              the transcript. */}
          <motion.figcaption
            className="absolute text-center"
            style={{ width: CAPTION, left: -CAPTION / 2 }}
            animate={{ y: size / 2 + LABEL_GAP }}
            transition={GRAVITY}
          >
            <div className="text-sm leading-tight">{name}</div>
            <div className="text-muted-foreground text-xs leading-tight">
              {phase[name] ?? "listening"}
            </div>
          </motion.figcaption>
        </motion.div>
      ))}
    </div>
  )
}
