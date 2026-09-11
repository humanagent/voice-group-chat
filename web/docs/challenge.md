# Conversation challenge: one prompt, as far as it goes

## The loop

A first visit asks **who is playing** before anything else: one dialog, one
field, and the reason attached — the agents read the name on every line, so it
is how they know which question is theirs to answer and what to call the person
who asked. It says the name is what scores are published under. Answering it is
the last time the name is asked for anywhere. It can be closed, and closing it
leaves the room exactly as it was before the dialog existed: the title is still
the field, and the composer still says what it is waiting for.

From there a round is: trophy → **Play** → one prompt → a result with a place
on it → **Play again**. The leaderboard is never in the way; it is a button on
the right of the header, and a quiet second action at the end of a round.

The room header has separate **Challenge** (trophy) and **Leaderboard** actions.
Challenge always opens a brief rules modal with a **0** counter. It is reachable
without a name: pressing it unnamed asks who is playing first and opens the rules
on the answer, rather than being a disabled button with no reason attached. Nothing is
recorded yet. **Play** closes that modal and activates the **existing composer
microphone** in that button gesture, just like tapping the chat's mic. There is
no separate voice input or capture modal. **Send recording** waits for the committed final transcript and starts
counting in the **existing shared room**. It starts a new counter, not a new
conversation. A recording has three ends: discard releases the microphone and
throws the words away, **Stop and review** releases it and puts the committed
transcript in the composer to be read, edited or abandoned, and send commits it
straight to the room. Only sending spends a turn, and in every case the next
typed or recorded prompt still counts. **Room mode** disarms the counter. Capture
failures recover received words to the same draft, never silently send partial
words. Visiting a page or leaderboard never starts the microphone.

From the moment Play is pressed, a **live counter sits beside the trophy** in
the header: the score in full ink with its unit under it, and nothing else — there
is no target to fill a track toward. It appears at 0 when the round is armed,
follows each counted reply, and disappears when the round ends, where the result
modal takes over the number. On a narrow phone the title drops its possessive for the length
of the round rather than truncating the player's name.

Each nonempty agent reply adds one point, including replies to the
original prompt and subsequent agent-to-agent replies. Introductions, silence,
errors and the user's prompt never count. Three replies mean three points.

**Play again** in the result starts the next round directly — the same gesture
that opens the microphone, without the rules modal a second time. The rules are
still shown by the trophy and by the scoreboard's **Play**.

Nothing ends the attempt by reaching a number, because there is no number to
reach. It ends when everyone goes quiet, the user stops/leaves, a failure prevents
it from continuing, or four minutes elapse — so the deadline, not a target, is what
bounds the paid turns one prompt can spend, and a lively room scores higher than
the old ceiling allowed. Missing room sessions are initialized
within that deadline; existing agents are not reintroduced. There is no second
prompt in an attempt. Retry resets only the score. Closing the result lets the
user keep chatting normally, with the same history and agents.

At the end, a centered trophy modal shows the large final score (for example
**2 replies**), with no top progress strip, and **no form**. The name was given at
the door, so a score of one or more publishes itself under it and the modal
answers with the place it took: **#4 of 61 on the board**. Every nonzero score is
published the same way; none of them is a win, and no entry carries a title. A score of **zero is never published** — nobody wants
their name on a board for a round where nothing was said — and that modal says
what to try instead. If publication cannot reach the board the score is kept and
the modal offers **Try again**; if the browser is offline it publishes itself
when the connection returns. Publication stays idempotent, so a reload after a
published round adds nothing and asks for nothing.

The scoreboard on `/challenge` shows the top 50 attempts, score descending; ties go to
the first publication. A **place is counted, not looked up in that list**, so it
exists below the fiftieth row. Each attempt appears at most once. Names may repeat:
they are nicknames, not accounts or verified identities. A score is a game
state, not a monetary payout or prize-redemption integration, and there is no
prize to win: the board is the whole reward.

`/challenge` is the leaderboard page; its centered **Play** button opens the
same rules modal as the trophy. Retry also shows the rules, not just on a first visit.
There is no secondary scoreboard route or
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
| `lib/challenge.ts` | Shared prompt limit, deadline, display types and nickname validation. No target. |
| `lib/room-session.ts` | Initialize only missing shared sessions; preserve existing context. |
| `lib/room-round.ts` | Shared delivery loop and single-process writer lock for normal/scored prompts and reset. |
| `lib/challenge-runner.ts` | Count new replies, persist terminal outcomes, and stop when the stored attempt stops. No session deletion. |
| `lib/challenge-store.ts` | Atomic SQLite updates, attempt ownership, admission limits, ranking, idempotent publication, and lifting the old twenty-reply ceiling off an existing database. |
| `lib/challenge-http.ts` | HttpOnly browser cookie, same-origin writes, bounded JSON and safe errors. |
| `components/name-gate.tsx` | The first-visit question, its validation and its refusal message. The only place a name is asked for. |
| `components/challenge-intro.tsx` | Rules, zero counter and what Play will do; Play delegates to the existing composer. No capture state. |
| `components/composer.tsx` | One recorder for normal/scored prompts, and the two ways to end it — to the room, or to the field; the intro's Play calls the same start action as the microphone button. |
| `components/challenge-score.tsx` | Centered accessible result dialog and scoreboard: publishes the finished score once, shows the returned place. No score calculation. |
| `components/room.tsx` | The live counter beside the trophy, and the single gate every saved run and place passes before it reaches the screen. |

`POST /api/challenge` accepts **only** `{ "message": "..." }`, at most 2,000
characters / 8,192 request bytes. It chooses the attempt ID, reuses `room`, stores
zero and streams ordinary room events plus `{ type: "challenge", run }`.
Independent listeners run in parallel, one possible point per in-flight call, for
as long as the attempt is running. The shared writer lock is released only after every in-flight
call settles, including cancellation. Each gateway request has a 30-second timeout and the attempt's abort
signal. Gateway silence is not a failure.

`GET /api/challenge` returns the current browser's latest saved result, with its
place on the board when it is published. Saved runs and places are validated in
the browser exactly as streamed events are (`isChallengeRun`, `isStanding`): a
malformed one becomes no result at all rather than a dialog with an empty heading
and a score reading "NaN". A random
256-bit HttpOnly, SameSite=Strict cookie owns attempts; only its SHA-256 hash is
stored in SQLite. HTTPS responses mark the cookie Secure. This is anonymous
ownership, not login. Clearing cookies loses access to unpublished results.
Reloading never repeats the prompt. A process crash leaves a run recoverable
as timed out after its deadline; it does not silently restart paid work.

`POST /api/challenge/scoreboard` accepts **only** `{ "runId": "...", "name": "..." }`.
It requires the same owner and a terminal attempt. The score comes from SQLite,
not the request, and the response carries the resulting place (`standing`),
counted with the ranking's own ordering — score, then who published first, then
the entry id — so the number and the visible list can never disagree. Repeated publication returns the same result without renaming
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

An existing database opens once with its twenty-reply CHECK constraint and its
`won` rows: the table is rebuilt in one transaction, scores and published places
survive untouched, and a win becomes the quiet ending it always was underneath.
The rebuild is keyed to that exact constraint, so it happens once and never again.

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
{"event":"challenge.finished","version":1,"score":24,"outcome":"quiet"}
{"event":"challenge.published","version":1,"score":24}
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

- `challenge-store.test.ts`: unbounded counting, points refused after a round
  ends, ownership, admission, deadlines, duplicate publication, ranking, places
  below the visible board, nickname validation, restart persistence, and a
  ceilinged legacy database lifted with its scores and places intact.
- `challenge-runner.test.ts`: three replies → three points, twenty-five replies →
  twenty-five, a stop mid-round ending delivery, no introduction/silence/error
  points, parallel listeners, cancellation and preserved shared context.
- `room-session.test.ts`: existing sessions cost no introductions, only missing
  members initialize, and outages never authorize a reset.
- `challenge-route.test.ts`: the stream-to-publication boundary, forged scores,
  cross-site requests, byte limits, ownership, cookies and shared-room concurrency.
- `browser/challenge.spec.ts`: the first-visit name dialog and its refusals, the
  trophy that asks for a missing name and opens the game on the answer, the
  live counter from Play, a round counted past the old ceiling, place/ranking
  flow, an unpublished zero, one-press Play again, an unreachable board, reload recovery
  without a duplicate publication, the single-prompt guard, accessibility and
  both dialogs on a keyboard-height viewport.
- `browser/dictation.spec.ts`: rules → Play → existing recorder, committed words
  submitted once, stop-and-review handing the transcript to the composer without
  sending it, the self-publishing result modal, cancellation cleanup and
  recovered-text fallback.

These tests do not claim live model performance, identical personalities across
visitors, production Railway volume attachment or physical-device validation.
