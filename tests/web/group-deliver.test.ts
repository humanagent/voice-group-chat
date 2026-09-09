import { afterEach, describe, expect, it, vi } from "vitest"
import { deliver } from "@/lib/group"

const agent = { name: "Anna", url: "http://anna.test", key: "test" }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe("deliver", () => {
  it("gives a cancellable turn the same 240s budget as an uncancellable one", async () => {
    // Every caller passes a signal, so a shorter budget here would cap every
    // ordinary reply and every introduction, not only the challenge.
    const timeout = vi.spyOn(AbortSignal, "timeout")
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: { content: "Done with the tool." } })))
    expect(await deliver(agent, "room", "you", "Look this up", new AbortController().signal)).toEqual({ spoke: true, text: "Done with the tool.", audio: null })
    expect(timeout).toHaveBeenCalledExactlyOnceWith(240_000)
    expect(await deliver(agent, "room", "you", "Look this up")).toMatchObject({ spoke: true })
    expect(timeout).toHaveBeenLastCalledWith(240_000)
  })
  it("still stops when the caller cancels", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason))
    })))
    const control = new AbortController()
    const pending = deliver(agent, "room", "you", "Hold on", control.signal)
    control.abort()
    expect(await pending).toMatchObject({ spoke: false, error: expect.any(String) })
  })
})
