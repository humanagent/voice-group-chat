/**
 * A token bucket per caller, and a ceiling over all of them.
 *
 * Two limits, because they answer different questions. The per-caller bucket
 * is fairness: one browser cannot starve the room for everybody else. The
 * ceiling is cost, and it is the one that actually protects the account —
 * a caller key is derived from a header the client can set, so per-caller
 * limits alone are a suggestion, while the ceiling holds no matter how many
 * identities one attacker invents.
 *
 * In memory, deliberately. This ships as a single Node process (the container
 * runs `next start` as PID 1), so process-wide state IS global state here.
 * Behind more than one replica each would enforce its own share and the
 * effective ceiling would multiply by the replica count; that is the moment to
 * move this to shared storage, and the moment it stops being true is a deploy
 * change rather than a code change, so it is written down here.
 */

type Bucket = { tokens: number; last: number }

export type Limit = {
  /** Sustained refill, in permits per minute. */
  perMinute: number
  /** How much of that can be spent at once. */
  burst: number
}

export type Verdict = { ok: true } | { ok: false; retryAfter: number }

/** Beyond this many tracked callers, idle buckets are swept before new ones are
 *  admitted. Without it, a caller key the client controls is itself a way to
 *  grow the process until it dies. */
const MAX_TRACKED = 10_000

export class RateLimiter {
  private callers = new Map<string, Bucket>()
  private all: Bucket

  constructor(
    private readonly each: Limit,
    private readonly ceiling: Limit,
  ) {
    this.all = { tokens: ceiling.burst, last: Date.now() }
  }

  /** One permit for this caller, or how long to wait. Charges the ceiling only
   *  when the caller's own bucket allowed it, so a single blocked caller cannot
   *  drain the budget everybody else is sharing. */
  take(caller: string, now: number = Date.now()): Verdict {
    const mine = this.bucket(caller, now)
    const wait = this.spend(mine, this.each, now)
    if (wait > 0) return { ok: false, retryAfter: wait }

    const shared = this.spend(this.all, this.ceiling, now)
    if (shared > 0) {
      // Hand the caller's permit back: it was the ceiling that refused, and
      // charging them for a request nobody could have made is how a busy
      // minute turns into a caller being throttled for a minute after it.
      mine.tokens += 1
      return { ok: false, retryAfter: shared }
    }
    return { ok: true }
  }

  private spend(bucket: Bucket, limit: Limit, now: number): number {
    const refill = ((now - bucket.last) / 60_000) * limit.perMinute
    bucket.tokens = Math.min(limit.burst, bucket.tokens + Math.max(0, refill))
    bucket.last = now
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return 0
    }
    // Whole seconds, and never zero: a Retry-After of 0 invites an immediate
    // retry that is guaranteed to fail again.
    return Math.max(1, Math.ceil(((1 - bucket.tokens) / limit.perMinute) * 60))
  }

  private bucket(caller: string, now: number): Bucket {
    const found = this.callers.get(caller)
    if (found) return found
    if (this.callers.size >= MAX_TRACKED) this.sweep(now)
    const fresh = { tokens: this.each.burst, last: now }
    this.callers.set(caller, fresh)
    return fresh
  }

  /** Drop anyone whose bucket has had time to refill completely: they are
   *  indistinguishable from a caller that has never been seen. */
  private sweep(now: number) {
    const full = (this.each.burst / this.each.perMinute) * 60_000
    for (const [caller, bucket] of this.callers) {
      if (now - bucket.last >= full) this.callers.delete(caller)
    }
    // Still full of active callers. Nothing here is safe to drop, so start
    // over rather than grow without bound; every caller keeps its permits.
    if (this.callers.size >= MAX_TRACKED) this.callers.clear()
  }
}

/**
 * Who to charge for a request.
 *
 * `x-forwarded-for` is what the platform's proxy sets, and its leftmost entry
 * is the client as that proxy saw it. A client can also send the header itself,
 * and the proxy appends rather than replaces — so this is a fairness key, not
 * an identity. The ceiling is what makes that acceptable.
 */
export function caller(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown"
}

/**
 * One limiter per name, for the life of the process.
 *
 * Next bundles each route separately, so a module-level instance is per-route
 * already; this pins it across the reloads a development server does and makes
 * the sharing explicit rather than incidental.
 */
export function limiter(name: string, each: Limit, ceiling: Limit): RateLimiter {
  const store = shared()
  const found = store.get(name)
  if (found) return found
  const made = new RateLimiter(each, ceiling)
  store.set(name, made)
  return made
}

function shared(): Map<string, RateLimiter> {
  const store = globalThis as typeof globalThis & { __limiters?: Map<string, RateLimiter> }
  store.__limiters ??= new Map()
  return store.__limiters
}

/** Start over. For tests, which would otherwise inherit whatever the previous
 *  one spent — the point of these buckets is that they survive a request. */
export function forgetLimiters(): void {
  shared().clear()
}
