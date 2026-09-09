# Developing and diagnosing the room

This frontend is an integration example, not a production multi-tenant service.
The useful contract is explicit: the UI owns interaction state, the recording
controller owns capture lifetime, the server keeps credentials, and tests own
their simulated services. You can verify the frontend without agent gateways
or an ElevenLabs account.

## First successful check — no credentials

Prerequisites: Node.js 22.13+ and pnpm 10.23.0. From the repository root:

```bash
pnpm --dir web install --frozen-lockfile
pnpm --dir web exec playwright install chromium webkit firefox
pnpm --dir web check
```

`check` runs lint, type-checks application **and test** code, runs the unit suite, builds
the production app with an intercepted test-only Sentry DSN, then starts the browser-test server on port 3100. It shuts
that server down afterward. Tests intercept agent and speech routes and the
ElevenLabs WebSocket; the placeholder key in `playwright.config.ts` only enables
voice controls. Do not replace it with a real key. Port 3100 must be available.

For a narrower loop:

```bash
pnpm --dir web test -- dictation.test.ts
pnpm --dir web test:e2e -- dictation.spec.ts --project=desktop
```

The browser command uses the most recent production build; run `pnpm --dir web build:test` after a UI
change. Use `pnpm --dir web build` for a normal build without the test DSN.
See [Running it](../README.md#running-it) to use real agent gateways and
speech. `pnpm start` at the **root** starts Hermes; `pnpm --dir web start` starts
the **web server**. These are intentionally different processes.

## A reading path through the code

For the one-prompt game and global scoreboard, see the [challenge developer
contract](challenge.md): scoring, ownership, SQLite persistence, admission limits
and the distinction between a demo win and prize-grade anti-cheat.

| Responsibility | Entry point | Boundary to preserve |
| --- | --- | --- |
| Server configuration | [`app/page.tsx`](../src/app/page.tsx) | Only agent names and a speech-enabled boolean reach the client; never API keys. |
| Conversation orchestration | [`components/room.tsx`](../src/components/room.tsx) | Serialize sends; distinguish interrupted/uncertain delivery; do not retry implicitly. |
| Shared server round | [`lib/room-round.ts`](../src/lib/room-round.ts) | Normal/scored prompts share `ROOM`, delivery and a writer lock; scoring never creates or deletes a session. |
| Challenge rules | [`components/challenge-intro.tsx`](../src/components/challenge-intro.tsx) | Always explain the game; only Play activates the composer's existing microphone. |
| Draft, input and capture | [`components/composer.tsx`](../src/components/composer.tsx) | Play calls the existing microphone action. Partial transcription updates stay here, outside the conversation render tree. |
| React recording lifecycle | [`hooks/use-dictation.ts`](../src/hooks/use-dictation.ts) | Adapts SDK/token calls and cleans up on unmount; reports only status transitions to the room. |
| Recording state machine | [`lib/dictation.ts`](../src/lib/dictation.ts) | Owns exactly one socket/microphone, flushes before commit, ignores stale callbacks. Dependencies are injectable for tests. |
| Credential exchange | [`app/api/scribe/route.ts`](../src/app/api/scribe/route.ts) | Server-only key, single-use token, no-store responses, bounded upstream wait. |
| Metrics contract | [`lib/telemetry-schema.ts`](../src/lib/telemetry-schema.ts) | Numeric allowlist, bounded values, no transcript payloads. |
| Browser transport | [`lib/telemetry.ts`](../src/lib/telemetry.ts) | Bounded buffers, best-effort batching; diagnostics must not block a conversation. |
| Sentry privacy boundary | [`lib/sentry-privacy.ts`](../src/lib/sentry-privacy.ts) | Reconstruct error/log payloads; allowlisted numeric metrics and bundle coordinates only, no attachments or arbitrary context. |
| Optional Sentry exporter | [`lib/sentry-client.ts`](../src/lib/sentry-client.ts) | No initialization without DSN; sample healthy visits, throttle repeated issues, export outside the render path. |

### Recording lifecycle

```text
idle → connecting → listening → finishing → idle
       │             │           │
       └─────────────┴───────────┴── cancel/error/timeout → idle
```

`connecting` ends only after both `SESSION_STARTED` and the first successfully
sent microphone chunk. A socket opening does not prove permission or worklet
setup succeeded. Setup has a 15-second deadline, including token fetch.

Partial and pre-commit final events replace the current segment; only a
`COMMITTED_TRANSCRIPT` appends it. Timestamp variants are not another segment.
Identical sentences in different segments are valid and must not be deduplicated
by text. The SDK may also commit long segments automatically.

The room uses manual commit for its explicit Send action. On Send, it disables
the capture track, lets two SDK audio chunks drain, then calls `commit()`. The
installed SDK batches 4096 samples at 16kHz (~256ms); draining allows buffered
speech to leave before the commit marker. No raw audio is inspected or logged.
This uses public SDK methods; a browser test runs the actual capture/worklet
path so SDK changes that break the boundary are visible.

Only an acknowledged commit completes the send. After six seconds without
finalization, the controller closes capture and returns the received text as a
recoverable draft. It cannot recover words the provider never returned. There
is no automatic replay or reconnect that could send duplicate messages.

This follows ElevenLabs' [transcript and commit semantics](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies).
Manual commit is a deliberate choice for this press-to-record / press-to-send
interaction, not a general recommendation for an always-on voice assistant.

## Diagnosing transcription

1. Open `http://localhost:3000/?perf=1`. Close the panel while speaking if needed.
2. Record a short phrase, then a phrase long enough to wrap. Tap Send immediately
   after the last word. Reopen diagnostics and download the report.
3. Compare the recording's timings below. Its random `id` matches `requestId`
   in the server's `speech.token` log. Reproduce one recording at a time: the
   local history is bounded, and the panel shows the latest recording only.

| Metric | Measures | Does **not** prove |
| --- | --- | --- |
| `dictation_token` | Start click to token response | Microphone access or socket readiness |
| `dictation_session` | Start click to provider session event | Actual audio capture |
| `dictation_audio_ready` / `dictation_ready` | First sent audio / both prerequisites ready | Recognition accuracy |
| `dictation_first_text` | Start click to first nonempty transcript | Pure model latency; it includes setup and any time before the user speaks |
| `dictation_render` | Provider text update to React layout commit, sampled at most once per second | Paint timing or a field INP score |
| `dictation_update_gap_max` | Longest interval between changed transcripts, emitted when recording ends | A network stall; silence also creates gaps |
| `dictation_updates` / `dictation_revisions` | Changed texts / partials that revise an earlier prefix | Recognition accuracy; corrections are normal |
| `dictation_finalize` | Send click to acknowledged final commit | Time to agent response |

Lifecycle counts include `dictation_start`, `dictation_complete` and
`dictation_cancel`. Errors have separate names: `dictation_error`,
`dictation_disconnect`, `dictation_connect_timeout`, `dictation_finalize_timeout`.
Missing metrics stay missing; a failed recording is never labeled successful.

For example, this is the **shape** of a server log, not a benchmark:

```json
{"event":"speech.token","version":1,"requestId":"<random UUID>","outcome":"provider_error","upstreamStatus":429,"durationMs":120}
```

`outcome` is `ready`, `not_configured`, `provider_error`, `invalid_response`,
`network_error` or `cancelled`. An upstream timeout is a network error. The
frontend metric batch uses `event: "frontend.performance"` and `version: 1`.

If token timing is slow, start at the server/upstream request. If a session
starts without audio readiness, check browser permission and audio-worklet
support. If text arrives promptly but render timing or frame intervals grow,
profile the browser. If rendering is fast but transcript updates are sparse,
investigate audio, network and provider behavior before changing animations.

Diagnostics are best effort, not an audit log: batches flush every 15 seconds
and on page hide, with at most 40 pending and 120 local samples. Nothing here
provisions retention, dashboards or alerts. Connect the structured server log
stream to your hosting platform's log drain if you need persistent analysis.
For optional error tracking and sampled numeric logs, see the
[Sentry configuration and privacy contract](../README.md#sentry-optional).

## Changes worth testing

- Recording lifecycle: [`dictation.test.ts`](../../tests/web/dictation.test.ts)
  covers final-word flush, duplicate events, cancellation, deadlines and recovery.
- Credential boundary: [`scribe-route.test.ts`](../../tests/web/scribe-route.test.ts)
  covers missing configuration, malformed responses, provider/network failures
  and redaction.
- Browser integration: [`dictation.spec.ts`](../../tests/web/browser/dictation.spec.ts)
  runs the SDK with a fake microphone and replayed WebSocket events on desktop
  and a mobile viewport. It checks one capture stream, ended tracks, final-word
  dispatch, recovery and log privacy. No provider call is made.
- Existing [`room.spec.ts`](../../tests/web/browser/room.spec.ts) covers chat,
  scroll behavior, IME, accessibility, PWA/offline and draft persistence.
- [`startup.spec.ts`](../../tests/web/browser/startup.spec.ts) delays browser
  scripts to check the real server-rendered input, then holds the room response
  to verify drafts become editable after hydration without waiting for agents.
  Saved text survives startup and remains editable offline; input geometry
  must not jump when its handlers become ready. The cached offline editor is
  tested with slow scripts and with local storage unavailable too.
- [`mobile.spec.ts`](../../tests/web/browser/mobile.spec.ts) covers layout bounds,
  touch targets, compact/landscape views and the Linux screenshot baselines.
- [`pwa.spec.ts`](../../tests/web/browser/pwa.spec.ts) simulates install/update events
  and verifies update guards, timeouts and draft recovery.
- [`motion.spec.ts`](../../tests/web/browser/motion.spec.ts) checks that modal
  entrances leave room geometry untouched and changing reduced motion or tab
  visibility rests the visuals without stopping speech. The audio clock is
  silent and deterministic; no provider request is made.
- [`visual-motion.test.ts`](../../tests/web/visual-motion.test.ts) checks elapsed-time
  easing at 30/60/90/120Hz and animation-loop suspension, resumption and cleanup.
  The shared helper only draws visuals; it must never own playback or recording.
- Sentry privacy unit tests and browser/Node envelope tests verify redaction
  with private-content sentinels and local transports, never a live account.

Browser artifacts live in `web/test-results/` and are ignored by Git. CI retains
review artifacts for seven days. Pixel comparisons run separately in a pinned
Linux Playwright container; see [Verification](../README.md#verification).
A mocked browser test proves integration
behavior, not real recognition quality, live provider latency or physical
iPhone/Safari behavior. Test those separately with consented speech; do not
commit recordings, credentials or real conversation traces.

### Installed iOS app and keyboard geometry

Chat routes lock document scrolling and keep the transcript as the scroll
container. `use-room-viewport.ts` follows both visual viewport **resize and pan**
while an input is focused and the keyboard reduces available height. Only
tracking height leaves the page displaced after iOS scrolls a field into view.
Without a keyboard, `100dvh` fills browser tabs and `100vh` fills installed PWAs;
the standalone height avoids WebKit's safe-area discrepancy. First focus does
not adopt a short stale visual viewport before a real resize occurs.
Keyboard mode also removes the extra home-indicator padding above the keyboard.
The mobile header and orb stage keep the same geometry before and after focus;
only the transcript area shrinks as the composer moves above the keyboard.
The stage is never hidden to make space. Long drafts scroll inside the input
in compact viewports. First input taps request focus with `preventScroll`
inside the touch gesture; later taps, selection, swipes and zoom stay native.
The leaderboard uses the same locked shell with its own scroll area; it never
unmounts the room or starts a microphone. Leaving the app restores document scrolling.

`browser/viewport.spec.ts` simulates a tall layout viewport with a smaller,
offset visual viewport, plus scroll-only updates and stale dismissal geometry.
Ordinary viewport resizing alone does not reproduce that iOS behavior. This
regression test is not a physical iPhone/installed-PWA certification; verify
open/type/send/dismiss/reopen and orientation changes on the target device.

## Deployment boundary

Keep this shared-room example behind access control before inviting untrusted
traffic. The API routes are not a tenant/authentication/rate-limiting layer;
agent credentials can dispatch terminal-capable work. Do not publish a personal
agent gateway or add client-visible provider keys to make a demo easier to run.
Telemetry excludes content, but speech still goes to ElevenLabs and chat goes
to the configured agents. Recovered text is intentionally saved in the local
draft: see [storage behavior](../README.md#chat-experience).
