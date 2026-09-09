# the room

Several agents in one chat, in a browser. Each one is its own gateway with its
own memory and its own voice, and each decides for itself whether a line was
meant for it. The orbs are how you watch that happen: who is thinking, who
spoke, who stayed quiet.

Next.js 16, React 19, ElevenLabs UI on top of shadcn. The ElevenLabs decisions
behind it are in the [root README](../README.md).

## Running it

The group has to be up first. From the repo root:

```bash
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

The mobile layout accounts for safe areas and the visual viewport so the
composer remains available when the keyboard opens. Drafts are stored on the
current device under `the-room-draft`; submitted messages and transcripts are
not stored in localStorage.

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

The implementation follows Next's
[client instrumentation](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client)
and [PWA conventions](https://nextjs.org/docs/app/guides/progressive-web-apps).

## Verification

```bash
pnpm test                      # parsing, stream failures, telemetry limits, existing logic
pnpm typecheck
pnpm build
pnpm exec playwright install chromium  # once
pnpm test:e2e                  # production app on port 3100
```

Browser tests cover desktop and a mobile viewport, drafts across reloads,
offline navigation, cache exclusions, message ordering, interrupted streams,
IME input, scrolling, reduced motion and automated accessibility checks.
Screenshots and traces are written to `web/test-results/` (ignored by Git).
Agent, microphone and speech requests are mocked in these tests; real voice
quality, physical iOS keyboard behavior and field performance still need device
testing. A local trace is not a field performance guarantee.
