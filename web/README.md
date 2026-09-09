# the room

Several agents in one chat, in a browser. Each one is its own gateway with its
own memory and its own voice, and each decides for itself whether a line was
meant for it. The orbs are how you watch that happen: who is thinking, who
spoke, who stayed quiet.

Next.js 16, React 19, ElevenLabs UI on top of shadcn. The ElevenLabs decisions
behind it are in the [root README](../README.md).

For a code walkthrough, credential-free verification and a transcription
troubleshooting recipe, start with the [developer guide](docs/developer-guide.md).

## Running it

Use Node.js 22 and pnpm 10.23.0 (the version pinned in `packageManager`).
Install the frontend dependencies once, then start the group. From the repo root:

```bash
pnpm --dir web install --frozen-lockfile
pnpm setup                             # once
pnpm start                             # the single runtime
uv run python scripts/group_up.py      # Anna, Jordan, Pepe
pnpm web                               # this app
```

There is nothing to configure locally. `scripts/group_up.py` writes `group.json`
at the repo root every time it starts the group, and this app reads the same
file the terminal client reads. The ElevenLabs key is read from `.hermes/.env`,
the same place the Python looks, so there is no second file to copy it into.

## Deploying

Vercel has no `group.json` and no localhost, so the same thing arrives as an
environment variable:

```
GROUP_AGENTS=[{"name":"Anna","url":"https://…","key":"…"}, …]
ELEVENLABS_API_KEY=…
```

Same fields as the file, plus a `url` instead of a port. A deploy is that file
copied into an env var, with the gateways reachable over the network. They are
not, by default: they bind `127.0.0.1`. Put them behind a tunnel or a host you
control before pointing a deployment at them, and remember that the key in that
variable dispatches terminal-capable agent work.

## How the live state works

Not from the trace files, which are on the machine the agents run on and a
deployment cannot read them. `POST /api/say` fans a line out to the agents the
way `round_of` does in the terminal client, and streams what happens as it
happens:

```
thinking  Anna       0.0s
thinking  Jordan     0.0s
thinking  Pepe       0.0s
quiet     Pepe       1.8s
quiet     Jordan     2.1s
said      Anna       4.6s   Pepe, say a number.
thinking  Pepe       4.6s
said      Pepe       8.6s   17
```

Every line reaches every agent, whoever said it. Each one decides for itself
whether it was meant, and that decision lives in the agents, not here, which is
why there is no copy of the addressing rules in this app to drift out of step
with theirs.

A round ends when nobody had anything to add. There is no cap and no filter:
two agents who keep answering each other will keep going, and closing the tab
aborts the request and the round with it.

## The routes

| | |
|---|---|
| `POST /api/say` | one turn of the room, as server-sent events |
| `GET /api/speak` | a reply spoken, as JSON: base64 audio plus character timings |
| `POST /api/scribe` | a single-use token for realtime transcription |
| `GET /api/history` | what a session already holds, on reload |
| `/api/room` | who is in it, and `DELETE` to empty it |
| `GET /api/audio` | a clip an agent attached itself, off its own disk |
| `POST /api/telemetry` | bounded numeric frontend metrics, written to structured server logs |

`/api/audio` only serves files under the agents' own Hermes homes, resolved
through symlinks before comparing. Deployed there are no such files and it
returns 404, and the room falls back to marking the line as spoken.

## Chat experience

The stage uses layered CSS gradients and transform animations. It does not load
Three.js or allocate WebGL contexts. Only the speaking orb samples audio, and
that loop pauses in hidden tabs and respects reduced motion. Messages are
memoized; typing updates the composer without rendering the transcript. Plain
text can follow the voice without swapping the paragraph's layout. Markdown
keeps a stable rendered tree throughout playback.

The transcript follows replies while you are at the bottom. Scrolling up lets
you read in place; the “Jump to latest messages” button brings you back. New
messages animate with opacity and a short translation. Enter sends, Shift+Enter
adds a line, and Enter during IME composition never sends. Queued messages are
serialized. A failed or incomplete stream is visibly marked and never retried
automatically, since the server may have received it. “Use as draft” lets you
review it before sending again. Clearing the shared room requires confirmation.

Microphone input lives inside the composer: partial words do not rerender the
room or its messages. There is only one microphone stream, owned by the SDK;
the recording indicator does not open another one. Long transcripts wrap and
follow their newest line unless you scroll back. Send mutes capture, drains
buffered audio, requests a final commit and waits for it before dispatching.
Timeouts and disconnects recover received text to the draft for explicit review,
never silently send an incomplete partial.

The mobile layout accounts for safe areas and the visual viewport so the
composer remains available when the keyboard opens. Drafts are stored on the
current device under `the-room-draft`. Conversation history and successful
recordings are not stored there; a recording recovered after an error becomes
part of that local draft. Shared-device users should clear drafts when finished.

## Install and offline behavior

Use the production server to try the PWA locally:

```bash
pnpm build
pnpm start                     # http://localhost:3000
```

The service worker is registered only in production, over HTTPS or localhost.
Chromium shows an install action once the browser offers installation. On iOS,
the install action explains Safari's Share → Add to Home Screen flow. Updates
are offered explicitly and cannot reload an active round or recording.

While an open room is offline, its visible conversation remains readable and
the composer saves your draft. An offline navigation or reload opens a small
cached page where the same draft can be edited. Reconnecting brings the draft
back to the room; sending always requires a connection and an explicit action.
The worker only caches a fixed list of public offline assets. It never caches
HTML from the live room, API responses, conversation history, audio or tokens.
This is intentionally not a background message queue or offline agent runtime.

Icons come from `public/icons/room.svg`. Run `pnpm icons` after editing it and
bump the cache version in `public/sw.js` when changing offline assets.

## Frontend observability

Open `/?perf=1` for the diagnostics panel and its JSON download. Measurements
are collected in ordinary visits too; the panel is optional. The app reports:

- Core Web Vitals (LCP, INP, CLS), FCP and TTFB through Next's Web Vitals hook.
- Long tasks where the browser supports them, plus a 2.5-second frame sample
  after interaction, at most once per ten seconds. The frame metric is the p95
  interval, not an estimated FPS or a guarantee about a device's refresh rate.
  Frames longer than 50ms are counted separately. No frame loop runs while idle.
- Room opening, first reply and completed round durations; numeric counts of
  runtime, promise, connection, speech and PWA failures. First-reply duration is
  only reported when an agent actually replies; quiet rounds do not invent one.
- Transcription token/session/audio readiness, first text, sampled render delay,
  finalization, update/revision counts and longest update gap. Failed/cancelled
  recordings have explicit outcomes. A random per-recording ID connects these
  samples to the server's `speech.token` JSON log. See the
  [metric definitions and troubleshooting flow](docs/developer-guide.md#diagnosing-transcription).

Missing values remain “Awaiting sample.” Vitals are finalized by the browser;
INP needs interaction and long-task support varies. Colored vital readings use
the [Web Vitals guidance](https://web.dev/articles/vitals). Frame and reply
measurements have no arbitrary green/red thresholds.

Events are batched every 15 seconds and on page hide to `/api/telemetry`.
The endpoint enforces same-origin browser requests, a 16KiB body limit, at most
40 samples, and a numeric event allowlist. It emits JSON records with
`event: "frontend.performance"` to the existing server log stream, usable with
your hosting provider's log search or drain. This repository does not provision
a durable analytics database, dashboards or alerts. Delivery is best effort;
memory is bounded to 120 local samples and 40 pending events. Export only
contains numeric samples, relative timing and browser-generated metric IDs;
message text, audio, agent names, URLs and error stacks are never included.
Token-route logs contain only a random request ID, an allowlisted outcome,
upstream HTTP status and duration. Raw provider errors are not returned or logged.
These guarantees cover application diagnostics; provider processing/retention
is governed by your ElevenLabs account, not this telemetry endpoint.

The implementation follows Next's
[client instrumentation](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client)
and [PWA conventions](https://nextjs.org/docs/app/guides/progressive-web-apps).

### Sentry (optional)

Copy the Sentry settings from [.env.example](.env.example) into your existing
`web/.env.local` without overwriting your provider configuration. Set
`NEXT_PUBLIC_SENTRY_DSN` to the project's public DSN, then rebuild and restart.
Without a DSN the SDK is not initialized. A separate `SENTRY_DSN` can override
the server destination. Use the environment settings to separate local,
staging and production reports. This repo does not create a Sentry project.

The integration captures browser exceptions, unhandled rejections, React render
failures and uncaught Next.js server request errors. Known room, stream, speech,
PWA and dictation failures become issues grouped by metric name, capped at one
issue per metric per minute per visit. They also produce numeric Sentry Logs.
Healthy timing logs are sampled for 10% of visits; operational failure logs are
always attempted. Export runs on the existing 15-second/page-hide batch, outside
the transcription render path. Delivery is best effort, including when offline
or an ad blocker blocks Sentry. The local diagnostics/export keep working.

Privacy is enforced in [sentry-privacy.ts](src/lib/sentry-privacy.ts), shared by
browser and server. Only known numeric metric names/values and sanitized error
types with bundled code coordinates are sent. Error messages, request bodies,
query parameters, headers, cookies, user context, local paths, stack variables,
console/DOM breadcrumbs and arbitrary log attributes are removed. Replay,
automatic tracing, session tracking and AI-content collection are disabled.
No audio, transcripts or draft text is sent by this integration. Sentry remains
a third-party network destination: configure its project retention, access and
IP-address storage settings appropriately. The intentional trade-off is less
error context; use stack locations, release and the numeric failure category.

For readable stacks, configure `SENTRY_ORG`, `SENTRY_PROJECT` and the secret
`SENTRY_AUTH_TOKEN` **in the deployment's build environment**. All three are
required before source-map uploading is enabled. The build plugin associates
the Git release and deletes uploaded client maps. Never use a `NEXT_PUBLIC_`
prefix for the auth token. CI tests need no Sentry secrets and never upload maps.

After configuring a real project, verify a consented test failure appears in
Issues, check a `room.performance` log, and inspect its fields before rollout.
Set project alerts for runtime errors, `dictation_finalize_timeout` and
`dictation_disconnect`; dashboard/alert provisioning is not automated here.
The implementation follows Sentry's [Next.js setup](https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/)
and explicitly opts out of its [data collection defaults](https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#dataCollection).

## Verification

```bash
pnpm test                      # parsing, stream failures, telemetry limits, existing logic
pnpm typecheck
pnpm build:test                 # production build with an intercepted, reserved test DSN
pnpm exec playwright install chromium webkit firefox  # once
pnpm test:e2e                  # production app on port 3100
pnpm check                     # lint, types (including tests), unit tests, build, browsers
```

Browser tests cover Chromium, mobile WebKit and Firefox, drafts across reloads,
offline navigation, cache exclusions, message ordering, interrupted streams,
IME input, scrolling, reduced motion and automated accessibility checks.
Screenshots and traces are written to `web/test-results/` (ignored by Git).
The transcription tests use Chromium's fake microphone through the real SDK
audio worklet, with a mocked provider WebSocket. They verify capture cleanup,
final-word delivery, recovery, long-text visibility and privacy-safe diagnostics.
They make no paid API calls. Sentry tests inspect actual browser and Node SDK
envelopes against private-content sentinels without contacting a Sentry account.
Install/update tests simulate browser events, including reload guards, a stalled
update and draft recovery. Real service-worker offline tests run on Chromium:
[Playwright cannot instrument that network lifecycle on the other engines](https://playwright.dev/docs/service-workers).

Visual assertions cover 320–430px portrait screens, 844px landscape, short tablet
windows, multiline drafts, keyboard-height/offline notices and iOS install help.
Installed-PWA fixtures include nonzero safe areas and a stale visual viewport:
the footer consumes the home-indicator inset once, then only 8px above the keyboard.
First-tap focus uses `preventScroll` inside the touch gesture (without moving or
hiding the input); subsequent selection, swipes and pinch zoom stay native.
The standalone resting surface uses `100vh`, while actual keyboard resize frames
use `visualViewport`. Focus alone never adopts a short stale viewport height.
This handles WebKit's documented [installed-app height discrepancy](https://bugs.webkit.org/show_bug.cgi?id=254868);
it still needs confirmation on a physical installed iPhone PWA.
`pnpm test:visual` compares committed screenshots in the pinned
`mcr.microsoft.com/playwright:v1.63.0-noble` Linux/amd64 environment used by CI.
Do not update baselines on macOS: system fonts differ. Review the images before
accepting changes with `pnpm test:visual --update-snapshots` in that container.
`ROOM_TEST_URL` can point visual tests at an already-running HTTPS/localhost
fixture server. Plain HTTP LAN/Docker hostnames are not secure browser contexts
and cannot exercise voice/UUID APIs. Prefer the default isolated port-3100
server inside the container, which starts automatically without credentials.

CI uploads screenshots/traces as `browser-review`, including successful runs.
After testing, use `pnpm build && pnpm start` for a normal local build (without
the test DSN). Real speech recognition quality, installed iOS behavior,
physical keyboard behavior and field performance still need device testing.
A local trace is not a field performance guarantee.
