# Hackapot: one prompt, 20 replies

Open `/challenge`, or the trophy in the room header. One prompt starts a fresh
attempt. Each nonempty agent reply adds one point, including replies to the
original prompt and subsequent agent-to-agent replies. Introductions, silence,
errors and the user's prompt never count. Three replies mean three points.

The 20th reply wins Hackapot and stops further delivery. Otherwise the attempt
ends when everyone goes quiet, the user stops/leaves, a failure prevents it
from continuing, or four minutes elapse. The deadline includes introductions.
There is no second prompt in an attempt. A retry starts from zero in fresh
sessions; it does not clear or reuse the shared room.

At the end, the player can enter a public nickname and choose **Publish score**,
or skip publication and play again. Scores below 20 can also be published.
`/challenge/scoreboard` shows the top 50 attempts, score descending; ties go to
the first publication. Each attempt appears at most once. Names may repeat:
they are nicknames, not accounts or verified identities. Hackapot is a win
state, not a monetary payout or prize-redemption integration.

## Trust boundary

```text
one prompt → server-owned attempt → actual agent replies → persisted score
                                                            ↓
                                      finish → optional name → public ranking
```

| Module | Owns |
| --- | --- |
| `lib/challenge.ts` | Shared target, prompt limit, display types and nickname validation. |
| `lib/challenge-runner.ts` | Agent introductions, counted delivery, cancellation, deadline and session cleanup. |
| `lib/challenge-store.ts` | Atomic SQLite updates, attempt ownership, admission limits, ranking and idempotent publication. |
| `lib/challenge-http.ts` | HttpOnly browser cookie, same-origin writes, bounded JSON and safe errors. |
| `components/challenge-score.tsx` | Progress, terminal result/name form and scoreboard. No score calculation. |

`POST /api/challenge` accepts **only** `{ "message": "..." }`, at most 2,000
characters / 8,192 request bytes. It chooses the attempt/session IDs, stores
zero and streams ordinary room events plus `{ type: "challenge", run }`.
Delivery is sequential so the 20th point does not leave extra model turns in
flight. Each gateway request has a 30-second timeout and the attempt's abort
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

The shared `/api/say` and `/api/history` endpoints accept only the shared room;
they cannot inject into or expose challenge sessions. All challenge API responses
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
and winner designation are public. No prompt/transcript enters the scoreboard
database or challenge logs. Agent providers still receive the conversation;
their session deletion is best-effort and does not promise provider erasure or
erase agent-wide memory. These are fresh conversations, not isolated agent VMs.

## Cost, abuse and diagnostics

Admission is capped at two simultaneous attempts, five starts per browser per
hour, and 30 starts server-wide per hour. Full capacity returns 429; an already
active attempt for the same browser returns 409. These conservative limits are
in `ChallengeStore.create`. Clearing cookies cannot bypass the global cap but
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
```

They contain no name, prompt, transcript, cookie or upstream error body. Existing
room timings/Sentry privacy filters continue to apply; no replay/tracing or
new personal-data logging is enabled.

## Verification

Run `pnpm --dir web check`. Unit tests use in-memory or temporary SQLite and
mocked gateways; browser tests mock APIs and never use provider credits.

- `challenge-store.test.ts`: hard cap, ownership, admission, deadlines, duplicate
  publication, ranking, nickname validation and restart persistence.
- `challenge-runner.test.ts`: three replies → three points, exact 20-reply stop,
  no introduction/silence/error points, abort and private-session cleanup.
- `challenge-route.test.ts`: the stream-to-publication boundary, forged scores,
  cross-site requests, byte limits, ownership, cookies and shared-room bypasses.
- `browser/challenge.spec.ts`: win/name/ranking flow, below-target result, skip,
  reload recovery, single-prompt guard, accessibility and compact mobile form.

These tests do not claim live model performance, identical personalities across
visitors, production Railway volume attachment or physical-device validation.
