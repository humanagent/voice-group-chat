export const metricNames = [
  "CLS", "LCP", "INP", "FCP", "TTFB", "frame_p95", "frame_stalls",
  "long_task", "room_ready", "first_reply", "round_duration",
  "runtime_error", "unhandled_rejection", "room_error", "stream_error",
  "speech_error", "pwa_error",
  "voice_ready", "voice_played", "voice_blocked", "voice_fallback",
  "dictation_start", "dictation_token", "dictation_session", "dictation_audio_ready", "dictation_ready",
  "dictation_first_text", "dictation_render", "dictation_update_gap_max", "dictation_updates", "dictation_revisions",
  "dictation_finalize", "dictation_complete", "dictation_cancel", "dictation_error",
  "dictation_connect_timeout", "dictation_finalize_timeout", "dictation_disconnect",
] as const

export type MetricName = (typeof metricNames)[number]
export type Sample = { name: MetricName; value: number; at: number; id?: string }

/** An allowlist keeps transcripts, URLs, stacks and credentials out of logs. */
export function parseSamples(input: unknown): Sample[] | null {
  if (!Array.isArray(input) || input.length > 40 || input.length === 0) return null
  const samples: Sample[] = []
  for (const item of input) {
    if (!item || typeof item !== "object" || !metricNames.includes(item.name) ||
      !Number.isFinite(item.value) || item.value < 0 || item.value > 86_400_000 ||
      !Number.isSafeInteger(item.at) || item.at < 0 ||
      (item.id !== undefined && (typeof item.id !== "string" || !/^[\w.-]{1,100}$/.test(item.id)))) return null
    samples.push({ name: item.name, value: item.value, at: item.at, ...(item.id ? { id: item.id } : {}) })
  }
  return samples
}

export function frameSummary(frames: number[]) {
  if (!frames.length) return null
  const sorted = [...frames].sort((a, b) => a - b)
  return { p95: sorted[Math.ceil(sorted.length * 0.95) - 1], stalls: frames.filter((ms) => ms > 50).length }
}
