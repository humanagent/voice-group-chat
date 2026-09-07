import { seedFor } from "@/lib/seed"

/** The orb's own colours, so a bubble is the same agent whichever layer draws it. */
const LIGHT = "#CADCFC"
const DEEP = "#A0B9D1"

/**
 * An agent, drawn with nothing that can be taken away.
 *
 * The WebGL orb is the better picture and it is not a floor to stand on. On one
 * browser here it logged `THREE.WebGLRenderer: Context Lost.` three times — one
 * per agent — and the stage was simply empty: a room with nobody in it, on the
 * one screen the whole demo is about. Contexts are a capped resource a browser
 * reclaims whenever it likes, so that is not a bug to fix once, it is a thing
 * that will happen again.
 *
 * So this is underneath, always, and it is real: the same palette, petals
 * turning on the same seeded clock, an agent recognisably itself. It paints on
 * the first frame, needs no GPU, and cannot be lost. The canvas fades in over
 * it when there is one and fades back out if it goes — and either way something
 * is on screen.
 */
export function SoftOrb({
  name,
  className,
  still = false,
}: {
  name: string
  className?: string
  still?: boolean
}) {
  const seed = seedFor(name)
  const id = `orb-${seed}`
  // Three, four or five blades, and its own starting angle: the same two
  // things the shader varies, so two agents never look alike.
  const petals = 3 + (seed % 3)
  const start = seed % 360
  const spin = 26 + (seed % 11)

  return (
    <svg viewBox="-50 -50 100 100" className={className} aria-hidden>
      <defs>
        {/* Bright at the rim, deeper toward the middle, the way the shader
            lights a blade. */}
        <radialGradient id={`${id}-g`} cx="50%" cy="50%" r="52%">
          <stop offset="25%" stopColor="#8FA8C4" />
          <stop offset="70%" stopColor={DEEP} />
          <stop offset="100%" stopColor={LIGHT} />
        </radialGradient>
        <filter id={`${id}-b`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="1.1" />
        </filter>
        <clipPath id={`${id}-clip`}>
          <circle cx="0" cy="0" r="48" />
        </clipPath>
      </defs>

      <g clipPath={`url(#${id}-clip)`}>
        <circle cx="0" cy="0" r="48" fill="#04060b" />
        <g filter={`url(#${id}-b)`}>
          <g transform={`rotate(${start})`}>
            {/* Reduced motion is honoured in the stylesheet by stopping the
                animation, not by removing the blades. */}
            {!still && (
              <animateTransform
                attributeName="transform"
                type="rotate"
                from={`${start}`}
                to={`${start + 360}`}
                dur={`${spin}s`}
                repeatCount="indefinite"
              />
            )}
            {Array.from({ length: petals }, (_, i) => (
              // One blade: out of the point at the centre, widening, capped by
              // a round outer edge against the rim.
              <path
                key={i}
                d="M0 0 Q -10 -21 -16 -34 A 17 17 0 0 1 16 -34 Q 10 -21 0 0 Z"
                fill={`url(#${id}-g)`}
                transform={`rotate(${(360 / petals) * i})`}
              />
            ))}
          </g>
        </g>
      </g>
    </svg>
  )
}
