# Conversation challenge: one prompt, 20 replies

The room header has separate **Challenge** (trophy) and **Leaderboard** actions.
Challenge activates the **existing composer microphone** in that button gesture,
just like tapping the chat's mic. There is no separate voice input or capture
modal. **Send recording** waits for the committed final transcript and starts
counting in the **existing shared room**. It starts a new counter, not a new
conversation. Discard releases the microphone without sending; the next typed
or recorded prompt still counts. **Room mode** disarms the counter. Capture
failures recover received words to the same draft, never silently send partial
words. Visiting a page or leaderboard never starts the microphone.

Each nonempty agent reply adds one point, including replies to the
original prompt and subsequent agent-to-agent replies. Introductions, silence,
errors and the user's prompt never count. Three replies mean three points.

The 20th reply wins the challenge and stops further delivery. Otherwise the attempt
ends when everyone goes quiet, the user stops/leaves, a failure prevents it
from continuing, or four minutes elapse. Missing room sessions are initialized
within that deadline; existing agents are not reintroduced. There is no second
prompt in an attempt. Retry resets only the score. Closing the result lets the
user keep chatting normally, with the same history and agents.

At the end, a centered trophy modal shows the large final score (for example
**2/20**), with no top progress strip. The player can enter a public nickname and choose **Publish score**,
or skip publication and play again. Scores below 20 can also be published.
The scoreboard on `/challenge` shows the top 50 attempts, score descending; ties go to
the first publication. Each attempt appears at most once. Names may repeat:
they are nicknames, not accounts or verified identities. Winning is a game
state, not a monetary payout or prize-redemption integration.

`/challenge` is the leaderboard page; its centered **Play** button activates the
same composer microphone as the trophy. There is no secondary scoreboard route or
separate challenge room. Returning to the scoreboard preserves an unfinished draft
or saved result. After a reload, **View result** recovers an unpublished score
without sending a prompt. **Back to the room** is always in the header; leaving
the page or stopping cancels an active attempt. Header view switches do not
unmount the room, interrupt a round, reset context or discard its draft. The
header contains Room, Challenge, Leaderboard and (when available) Install actions. Room
navigation never clears shared history. The former clear-context and volume
actions and duplicate scoreboard links are no longer in the header/content.
The scoreboard is the challenge landing screen, without the agent stage above
it; Play returns to the room with its orbs and existing recording controls visible.

## Trust boundary

```text
one prompt → server-owned attempt → actual agent replies → persisted score
                                                            ↓
                                      finish → optional name → public ranking
```

| Module | Owns |
| --- | --- |
| `lib/challenge.ts` | Shared target, prompt limit, display types and nickname validation. |
| `lib/room-session.ts` | Initialize only missing shared sessions; preserve existing context. |
| `lib/room-round.ts` | Shared delivery loop and single-process writer lock for normal/scored prompts and reset. |
| `lib/challenge-runner.ts` | Count new replies, persist terminal outcomes and stop exactly at 20. No session deletion. |
| `lib/challenge-store.ts` | Atomic SQLite updates, attempt ownership, admission limits, ranking and idempotent publication. |
| `lib/challenge-http.ts` | HttpOnly browser cookie, same-origin writes, bounded JSON and safe errors. |
| `components/composer.tsx` | One recorder for normal/scored prompts; Challenge/Play calls the same start action as the microphone button. |
| `components/challenge-score.tsx` | Centered accessible result/name dialog and scoreboard. No score calculation. |

`POST /api/challenge` accepts **only** `{ "message": "..." }`, at most 2,000
characters / 8,192 request bytes. It chooses the attempt ID, reuses `room`, stores
zero and streams ordinary room events plus `{ type: "challenge", run }`.
Independent listeners run in parallel, reserving at most one possible point
per in-flight call. At 19, only one listener runs, so there are no extra paid
turns past 20. The shared writer lock is released only after every in-flight
call settles, including cancellation. Each gateway request has a 30-second timeout and the attempt's abort
signal. Gateway silence is not a failure.

`GET /api/challenge` returns the current browser's latest saved result. A random
256-bit HttpOnly, SameSite=Strict cookie owns attempts; only its SHA-256 hash is
stored in SQLite. HTTPS responses mark the cookie Secure. This is anonymous
ownership, not login. Clearing cookies loses access to unpublished results.
Reloading never repeats the prompt. A process crash leaves a run recoverable
as timed out after its deadline; it does not silently restart paid work.

`POST /api/challenge/scoreboard` accepts **only** `{ "runId": "...", "name": "..." }`.
It requires the same owner and a terminal attempt. The score comes from SQLite,
not the request. Repeated publication returns the same result without renaming
or duplicating it. Nicknames are normalized, 1–24 characters, and exclude markup,
control characters and invisible direction/formatting characters. React renders
them as text. Public entries use a different random ID from private attempts.

The shared `/api/say` and `/api/history` endpoints accept only `room`. Normal
chat, scored chat and the terminal use the same agent histories. Web prompts
and explicit resets return 409 while another web round holds the room lock;
direct gateway/terminal clients bypass that lock. All challenge API responses
are network-only/no-store; the service worker already excludes `/api/`.

## Persistence and Railway

Requires **Node.js 22.13+** for built-in `node:sqlite` (still experimental on Node
22). No new hosted database, provider key or client dependency is needed.
The database is `${HERMES_GROUP_STATE}/.hermes/challenge/scoreboard.sqlite`;
locally the state root defaults to the repository. This directory is ignored
by Git. SQLite uses WAL and parameterized statements; admission checks run in
one immediate transaction, so concurrent requests cannot bypass capacity.

The existing container sets `HERMES_GROUP_STATE=/data`. **Railway must have a
persistent volume mounted at `/data`** for rankings to survive redeploys. An
environment variable or directory alone is not a volume. This PR does not create
or change Railway resources. Back up the volume/database, including WAL state,
using a consistent SQLite backup. Do not copy just the live main database file.

This implementation targets the repo's single-service, mounted-volume topology,
not independent replicas with separate files. Railway's [volume limitations](https://docs.railway.com/volumes/reference)
also exclude replicas. Multi-region/multi-service deployment needs a shared
database before enabling the challenge across instances.

Unpublished attempt metadata is pruned after seven days on admission. Published
scores remain until an operator removes them. Only the nickname, numeric score
and winner designation enter the public ranking. No prompt/transcript enters
the scoreboard database or challenge logs. **The conversation itself stays in
the shared room, visible to other room visitors and agent providers.** Closing,
stopping, retrying and publishing never delete it. Previous context influences
future attempts; this is not a fresh-context comparison or isolated agent VM.

## Cost, abuse and diagnostics

The shared room admits **one web round at a time**, normal or scored (409 while
busy). Storage also caps active records at two for recovery after a restart,
five starts per browser per hour, and 30 starts server-wide per hour. Storage
capacity returns 429; an active attempt for the same browser returns 409.
These storage limits are in `ChallengeStore.create`. Clearing cookies cannot bypass the global cap but
can bypass the per-browser limit. Existing non-challenge routes have their own
security limitations; these are not service-wide spending limits.

This is a demo challenge, **not prize-grade anti-cheat or a public agent sandbox**.
Scores attest to observed replies, not semantic quality: agents may repeat
themselves, and prompts can explicitly ask them to keep talking. Before inviting
untrusted traffic, isolate the underlying agents and tools, add edge abuse
protection/access controls, and decide on nickname moderation. A terminal-capable
personal agent should not be exposed as an unrestricted public game.

Structured server logs contain only:

```json
{"event":"challenge.finished","version":1,"score":20,"outcome":"won"}
{"event":"challenge.published","version":1,"score":20}
{"event":"challenge.storage_error","version":1}
{"event":"challenge.run_error","version":1}
```

They contain no name, prompt, transcript, cookie or upstream error body. Existing
room timings/Sentry privacy filters continue to apply; no replay/tracing or
new personal-data logging is enabled.
Gateway requests always target `room`, so the existing `group-trace.jsonl`
tailing tools and normal chat follow exactly the same context. No `challenge-*`
agent sessions are minted or deleted.

## Verification

Run `pnpm --dir web check`. Unit tests use in-memory or temporary SQLite and
mocked gateways; browser tests mock APIs and never use provider credits.

- `challenge-store.test.ts`: hard cap, ownership, admission, deadlines, duplicate
  publication, ranking, nickname validation and restart persistence.
- `challenge-runner.test.ts`: three replies → three points, exact 20-reply stop,
  no introduction/silence/error points, parallel listeners, cancellation and preserved shared context.
- `room-session.test.ts`: existing sessions cost no introductions, only missing
  members initialize, and outages never authorize a reset.
- `challenge-route.test.ts`: the stream-to-publication boundary, forged scores,
  cross-site requests, byte limits, ownership, cookies and shared-room concurrency.
- `browser/challenge.spec.ts`: win/name/ranking flow, below-target result, skip,
  reload recovery, single-prompt guard, accessibility and compact mobile form.
- `browser/dictation.spec.ts`: one-click challenge recording, committed words
  submitted once, result modal, cancellation cleanup and recovered-text fallback.

These tests do not claim live model performance, identical personalities across
visitors, production Railway volume attachment or physical-device validation.
