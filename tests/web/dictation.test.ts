import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RealtimeEvents, type RealtimeConnection } from "@elevenlabs/client"
import { Dictation } from "@/lib/dictation"

function setup() {
  const listeners = new Map<string, (data: never) => void>()
  const connection = {
    on: (event: string, listener: (data: never) => void) => { listeners.set(event, listener) },
    send: vi.fn(), mute: vi.fn(), commit: vi.fn(), close: vi.fn(),
  } satisfies Pick<RealtimeConnection, "on" | "send" | "mute" | "commit" | "close">
  const deps = {
    token: vi.fn(async () => "test-only-token"), connect: vi.fn(() => connection),
    changed: vi.fn(), completed: vi.fn(), failed: vi.fn(), metric: vi.fn(),
  }
  const dictation = new Dictation(deps)
  function emit(event: RealtimeEvents, data = {}) { listeners.get(event)?.(data as never) }
  function audio() { connection.send({ audioBase64: "test-only-audio" }) }
  async function start() {
    await dictation.start()
    emit(RealtimeEvents.SESSION_STARTED)
    audio()
  }
  return { dictation, deps, connection, emit, audio, start }
}

/** PCM16, little-endian, exactly as the SDK sends it. */
function pcm(samples: number[]): string {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((value, index) => view.setInt16(index * 2, value, true))
  return Buffer.from(bytes).toString("base64")
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }))
afterEach(() => vi.useRealTimers())

describe("recording lifecycle", () => {
  it("requires both the service session and actual microphone audio before enabling send", async () => {
    const { dictation, deps, emit, audio } = setup()
    await dictation.start()
    emit(RealtimeEvents.SESSION_STARTED)
    expect(deps.changed.mock.lastCall?.[0].status).toBe("connecting")
    audio()
    expect(deps.changed.mock.lastCall?.[0].status).toBe("listening")
    dictation.cancel()
  })

  it("flushes capture and waits for committed text, not the partial visible at the click", async () => {
    const { dictation, deps, connection, emit, audio, start } = setup()
    await start()
    emit(RealtimeEvents.PARTIAL_TRANSCRIPT, { text: "Hola" })
    dictation.finish()
    dictation.finish() // Double clicking cannot create another commit.
    expect(connection.mute).toHaveBeenCalledTimes(1)
    expect(connection.close).not.toHaveBeenCalled()
    audio()
    expect(connection.commit).not.toHaveBeenCalled()
    audio()
    audio()
    expect(connection.commit).toHaveBeenCalledTimes(1)
    expect(deps.completed).not.toHaveBeenCalled()
    emit(RealtimeEvents.FINAL_TRANSCRIPT, { text: "Hola, mundo." })
    expect(deps.completed).not.toHaveBeenCalled()
    emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: "Hola, mundo." })
    expect(deps.completed).toHaveBeenCalledExactlyOnceWith("Hola, mundo.")
    expect(connection.close).toHaveBeenCalledTimes(1)
    expect(deps.changed.mock.lastCall?.[0].status).toBe("idle")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps repeated segments while treating final and timestamp events as non-duplicating", async () => {
    const { dictation, deps, emit, audio, start } = setup()
    await start()
    emit(RealtimeEvents.PARTIAL_TRANSCRIPT, { text: "Sí" })
    emit(RealtimeEvents.FINAL_TRANSCRIPT, { text: "Sí." })
    emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: "Sí." })
    emit(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, { text: "Sí." })
    emit(RealtimeEvents.PARTIAL_TRANSCRIPT, { text: "Sí" })
    dictation.finish()
    audio(); audio()
    emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: "Sí." })
    expect(deps.completed).toHaveBeenCalledWith("Sí. Sí.")
  })

  it("returns recoverable text on a finalize timeout and never sends it automatically", async () => {
    const { dictation, deps, connection, emit, start } = setup()
    await start()
    emit(RealtimeEvents.PARTIAL_TRANSCRIPT, { text: "Keep this thought" })
    dictation.finish()
    await vi.advanceTimersByTimeAsync(6000)
    expect(deps.completed).not.toHaveBeenCalled()
    expect(deps.failed).toHaveBeenCalledWith(expect.stringContaining("timed out"), "Keep this thought")
    expect(connection.close).toHaveBeenCalledTimes(1)
    emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: "Too late" })
    expect(deps.completed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([RealtimeEvents.ERROR, RealtimeEvents.CLOSE])("recovers text and releases capture on %s", async (event) => {
    const { deps, connection, emit, start } = setup()
    await start()
    emit(RealtimeEvents.PARTIAL_TRANSCRIPT, { text: "Recover this" })
    emit(event, { error: "sensitive provider detail" })
    emit(RealtimeEvents.CLOSE)
    expect(deps.failed).toHaveBeenCalledTimes(1)
    expect(deps.failed.mock.lastCall?.[1]).toBe("Recover this")
    expect(connection.close).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(deps.metric.mock.calls)).not.toContain("sensitive")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("bounds connection setup, including unanswered microphone permission", async () => {
    const { dictation, deps, connection, emit } = setup()
    await dictation.start()
    emit(RealtimeEvents.SESSION_STARTED)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.failed).toHaveBeenCalledOnce()
    expect(connection.close).toHaveBeenCalledOnce()
    expect(deps.metric).toHaveBeenCalledWith("dictation_connect_timeout", 1, expect.any(String))
  })

  it("cancels an in-flight token request and rejects late results without opening a socket", async () => {
    const { dictation, deps } = setup()
    let resolve!: (token: string) => void
    deps.token.mockImplementation(() => new Promise((done) => { resolve = done }))
    const pending = dictation.start()
    await dictation.start()
    expect(deps.token).toHaveBeenCalledOnce()
    dictation.cancel()
    resolve("late-token")
    await pending
    expect(deps.connect).not.toHaveBeenCalled()
    expect(deps.completed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reports numeric timings, revisions and counts without transcript or audio content", async () => {
    const { dictation, deps, emit, start } = setup()
    await start()
    await vi.advanceTimersByTimeAsync(100)
    emit(RealtimeEvents.PARTIAL_TRANSCRIPT, { text: "private ward" })
    await vi.advanceTimersByTimeAsync(200)
    emit(RealtimeEvents.PARTIAL_TRANSCRIPT, { text: "private word" })
    dictation.cancel()
    expect(deps.metric).toHaveBeenCalledWith("dictation_first_text", 100, expect.any(String))
    expect(deps.metric).toHaveBeenCalledWith("dictation_update_gap_max", 200, expect.any(String))
    expect(deps.metric).toHaveBeenCalledWith("dictation_revisions", 1, expect.any(String))
    expect(deps.metric).toHaveBeenCalledWith("dictation_updates", 2, expect.any(String))
    const metrics = JSON.stringify(deps.metric.mock.calls)
    expect(metrics).not.toMatch(/private|test-only-audio|test-only-token/)
  })
})

describe("the loudness meter", () => {
  it("reads the audio it is already sending, loud from quiet", async () => {
    // The bars on screen are the only answer to "is it hearing me", so they are
    // taken from the bytes going to the transcriber rather than from a second
    // tap that could disagree with it.
    const { dictation, connection, start } = setup()
    await start()
    connection.send({ audioBase64: pcm([...Array(256).fill(16384), ...Array(256).fill(0)]) })
    const levels = dictation.levels()
    expect(levels.length).toBe(2)
    expect(levels[0]).toBeCloseTo(0.5, 2)
    expect(levels[1]).toBe(0)
  })

  it("takes the bare string the SDK also sends", async () => {
    const { dictation, connection, start } = setup()
    await start()
    connection.send(pcm(Array(256).fill(8192)) as never)
    expect(dictation.levels()[0]).toBeCloseTo(0.25, 2)
  })

  it("never lets a payload it cannot read cost a word", async () => {
    const { dictation, deps, connection, start } = setup()
    await start()
    expect(() => connection.send({ audioBase64: "not base64 at all !!" })).not.toThrow()
    expect(() => connection.send({ nothing: true } as never)).not.toThrow()
    expect(dictation.levels()).toEqual([])
    expect(deps.failed).not.toHaveBeenCalled()
  })

  it("starts each recording from silence, not from the last one's tail", async () => {
    const { dictation, connection, start } = setup()
    await start()
    connection.send({ audioBase64: pcm(Array(256).fill(16384)) })
    expect(dictation.levels().length).toBe(1)
    dictation.cancel()
    await dictation.start()
    expect(dictation.levels()).toEqual([])
  })
})
