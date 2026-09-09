# Running the group layer on Hermes, locally

How the decision layer works and how to run it from a terminal. One local HTTP
port per agent, no messaging platform. The ElevenLabs side of the project, and
the browser room, are in the [root README](README.md).

## What this is

Upstream Hermes Agent, with the group-chat wrapper loaded as a plugin and the
personality supplied through the two slots Hermes already has. The wrapper does
three things to every turn:

- injects the group context before the model call (`llm_request` middleware)
- reads the model's silence token and turns it into `NO_REPLY`
- caps the visible reply at 250 characters

## Setup

```sh
uv sync
```

### Getting started

```sh
pnpm setup      # writes .hermes/config.yaml, .hermes/.env, .hermes/SOUL.md
```

It never overwrites what is already there, and everything it writes is
gitignored — which is why a fresh clone has none of it. It does **not** rebuild
the personality: `context/` is committed so a clone can run without the
templates it came from.

Then put a provider key in `.hermes/.env` and `pnpm start`.

### Its own Hermes home

This project does not use `~/.hermes`. It keeps its own home at `.hermes/` in
the repo, set through `HERMES_HOME` by every command. Sharing the global home
means this project's config, keys and session database land in the middle of
whatever else the machine already uses Hermes for, and "delete everything" stops
being a safe thing to say.

`.hermes/` is gitignored: it holds the keys and the session database.

## Changing the model

One line, in `src/defaults.py`:

```python
DEFAULT_MODEL = "openai/gpt-5.6-sol"
TTS_MODEL = "eleven_flash_v2_5"
```

Every home is pointed back at those on start, and says so when it moves one:

```
Anna: z-ai/glm-5.3 -> openai/gpt-5.6-sol
Jordan: z-ai/glm-5.3 -> openai/gpt-5.6-sol
Pepe: z-ai/glm-5.3 -> openai/gpt-5.6-sol
```

Editing a `config.yaml` directly does not stick, on purpose. There are four of
them — one per agent plus the single-agent runtime — and letting them disagree
is how changing the model became editing four files and forgetting one. They
are generated state in a gitignored directory, not somewhere to keep notes; a
model change belongs in a diff.

`.hermes/config.yaml`:

```yaml
model:
  default: openai/gpt-5.6-sol

plugins:
  enabled:
    - group-layer          # without this the plugin is discovered and skipped

platforms:
  api_server:
    enabled: true
    extra:
      host: 127.0.0.1
      port: 8642
```

`.hermes/.env`:

```sh
OPENROUTER_API_KEY=...
API_SERVER_KEY=...                    # openssl rand -hex 32; under 16 chars is refused
HERMES_GROUP_CONTEXT=/abs/path/to/hermes-elevenlabs/context
```

## Run

`pnpm tui` opens the categories:

```
group     talk to the room
debug     watch the room's log, live
replay    the room's log from the top
runtime   start, stop, restart
```

**debug** opens the log straight away, because there is one room and picking
it is not a choice anybody has. It reads all three agents at once: each traces
into its own home, and the interesting thing about a group turn is which of
them spoke and which stayed quiet, which is only visible side by side.

It starts live — what you almost always want is the turn you are about to
provoke, and a screen that opens on hours of backlog buries it. **replay** is
the same log from the top.

## personas/

The other folder of Markdown, and the opposite kind. `context/` is what every
agent is told on every turn — the shared contract, the thing they all agree on.
`personas/` is a deck of backstories: ten people at one fictional company, each
with a role, a history and a temperament, and no name of their own.

The first time the room opens, one is dealt at random to each agent, inside the
introduction it was already getting — so opening the room costs one turn per
agent rather than two. An agent's persona goes to that agent's session and
nowhere else: the others cannot read it, which is the only reason the room is
worth watching.

The deal is written to `.hermes/cast.json` and read back after that. Clearing
the room empties every session but keeps the cast, because an agent who ran
support before you cleared it and security after is not a cleared context — it
is a different person wearing the same name.

Delete the folder and the room still opens; the agents are simply nobody in
particular, exactly as they were before.

The underlying scripts still run directly if you want them:

```sh
uv run python scripts/group_up.py Anna Jordan Pepe   # one home per agent
uv run python scripts/group.py                       # the room, in a terminal
uv run python scripts/tui.py                         # the decision log
```

To confirm the plugin actually loaded, boot with `HERMES_PLUGINS_DEBUG=1` and
look for:

```
Plugin group-layer registered middleware: llm_request
Plugin group-layer registered hook: transform_llm_output
```

A failed plugin import is swallowed into a warning, so the gateway boots
perfectly well **without** the layer. Always check for those lines.

## How silence surfaces

`gateway/response_filters.py` is what turns `NO_REPLY` into "send nothing", and
it is only wired into the messaging-platform dispatch path. `api_server.py` never
references it, so over HTTP the turn comes back with `"content": "NO_REPLY"`.

That is the correct layering, not a bug: the wrapper's job ends at emitting the
decision, and whichever consumer sits on top decides what to do with it. On
Telegram the gateway sends nothing. On HTTP the client renders nothing. It is
also the exact seam an SDK would expose.

## Watching it decide

Not a dashboard: a log. Timestamped,
prefixed, greppable, and copy-pasteable into a bug report. The plugin's decision
trace and the gateway's own stdout are merged as they arrive.

```
20:06:58 [turn]    chat=log-1787872016 history=1 first=true
20:06:58          in  Fabri: agent, fijate si llueve manana en Buenos Aires
20:06:58 [ctx]     48,206 chars via messages
20:07:03 [llm]     round=1 model=openai/gpt-5.6-sol in=25,818 (cache_r=0 hit=0%) out=343 finish=tool_calls tools=2 5.3s
20:07:05 [tool]    terminal 2.12s
20:07:11 [tool]    terminal 4.73s
20:07:13 [llm]     round=2 model=openai/gpt-5.6-sol in=1,280 (cache_r=25,088 hit=95%) out=35 finish=stop 2.1s
20:07:13 [policy]  spoke   raw=114 → 114
20:07:13          out Mañana en Buenos Aires no parece que llueva: probabilidad máxima 12%…

20:07:13 [turn]    chat=log-1787872016 history=6 first=false
20:07:13          in  Anna: che jordan viste la hora ⏎ Jordan: si ya se
20:07:16 [llm]     round=1 model=openai/gpt-5.6-sol in=310 (cache_r=26,112 hit=99%) out=81 finish=stop 3.2s
20:07:16 [policy]  quiet   reason='suppress token' raw=8 → 0
```

Four prefixes, so they can be grepped: `[turn]` opened a turn, `[llm]` one API
round, `[tool]` one tool call, `[policy]` the decision. Several `[llm]` rounds in
one turn is the tool loop, and it is usually the answer to "why was that slow".

`quiet` is the layer working, not a failure. What deserves attention is
`dropped=`, which means the model asked for a reaction, a threaded reply or a
profile change and the plugin parsed it out and discarded it.

Tracing is off unless asked for. `HERMES_GROUP_TRACE=1` writes to
`$HERMES_HOME/group-trace.jsonl`; any other value is treated as a path. It
swallows its own exceptions by design — a full disk must never cost a reply.

## What the layer does, against the field notes

The post this came from ("Teaching an agent to shut up") names ten patterns.
Where each one stands here:

| Pattern | |
|---|---|
| **Silence token** — the model ends in `SILENT`/`NO_REPLY` and the transport drops the message | ✅ `policy/suppress_tokens.py` |
| **Brevity cap** — a hard limit on the visible reply, synthesised then clamped | ✅ `policy/outbound_length.py` |
| **Judgment** — was the agent spoken to? | ✅ `policy/addressing.py`, deterministic and ahead of the model |
| **Listen mode** — speak / mentions-only / paused, set by the chat | ✅ `policy/participation.py`, `/mode` inside the room. **Mentions-only is the default**: a chat gets an agent that reads and remembers from the first message and answers when called. Enforced twice — the model is told which turn it is, and the gate catches the ones where it answers anyway |
| **Check-in acks** — scheduled work delivers something real or stays silent | ✅ `policy/checkins.py`, judged on the shape of the reply |
| **Delivery fingerprint** — a check-in has no memory of its last run and will post the same news twice | ✅ `policy/checkins.py`, against a short history |
| **Maintenance turns** — upstream's own memory/skill reviews never speak | ✅ `policy/review_turns.py` |
| **Lane separation** — hiding text and cancelling effects are different switches | ✅ `policy/turn_gate.py`, a silenced turn still ships what it made; a paused chat ships nothing |
| **Reasoning is not a message** | ✅ by construction — the hook is handed the final response, never the narration |
| **Delegation** — the child inherits tools, not personality | 🟡 in the context; the mechanism is upstream's `delegate_task` |
| **Coalescing** — hold a burst and answer it once | ❌ needs the inbound before the turn starts, which no hook exposes on `api_server` |
| **Dispatch queues** — one queue per source, drained in a fixed order | ❌ same |

Typing indicators, threaded replies and reactions are deliberately out of scope:
this runtime has no transport that carries them.

Every rule that ends a turn goes through one place, `policy/turn_gate.py`, and
returns a verdict rather than a bare bool — because they do not all mean the
same thing for what rides along with the words.

### The agent answers to "agent"

`HERMES_AGENT_NAME`, default `agent`. It reaches three ways: the bare word,
`@agent`, and `@agente`. The Spanish spelling is matched too, because refusing
it would leave a deliberate address unheard, which is the expensive failure.

The room starts in mentions-only, so out of the box:

```
hola como andan             → nothing
alguien sabe que hora es?   → nothing
agent, que hora es?         → "Son las 6:43 PM en Buenos Aires."
hey @agente todo bien?      → "Todo bien, acá estoy 🙂 ¿vos?"
```

`/mode speak | mention | paused`, typed inside the room, moves it: `speak` lets
the whole layer decide as before, `paused` runs nothing (scheduled work still
does). The switch belongs to the group, so it is written into every agent's home
at once.

## Tests

250 Python tests and 34 in the browser client, six of which run against a live
gateway. The six exist because
every bug this layer has had got past the units: the flag that swallowed real
replies, the preamble that broke the prompt cache, the vocative without a comma.
All three were found by reading the log of a real turn and pinned by a unit test
only afterwards.

They skip when nothing is listening, so `pnpm test` stays useful with the
runtime down, and `pnpm test:unit` is the fast loop. Each of the six is a case
that has actually been wrong at some point, which is why there are six and not
sixty: they cost real tokens.

## Memory is shared across chats

One gateway serves every chat and they share one memory. A name learned in one
chat is known in all of them:

```
.hermes/memories/USER.md
  User's name is Fabrizio and he lives in Buenos Aires.
```

That is upstream's model, not something this layer sets. It is fine for one
person testing and wrong for the product it is imitating, where each agent is
its own instance with its own memory. Worth knowing before reading anything into
what the agent appears to remember about a chat: it may have learned it
somewhere else.

## A group of agents

```sh
groups group        # starts them if they are not up, then opens the room
groups group:up Anna Jordan Pepe    # or name them yourself
groups group:down
```

`group_up.py` writes one Hermes home per agent (`.hermes-anna/`, …) and a
`group.json` saying where they live. Both are gitignored: they hold keys and
session databases. It reuses the provider key and model from `.hermes/`, so a
group needs no credentials of its own.

Every agent is told the roster and which of the names it is. Without that it
knows only its own name and cannot tell a question aimed at Jordan from one
aimed at itself — the exact mistake the addressing rules exist to prevent, made
unfixable by missing information.

There is no cap on how far a line travels. What ends a round is that nobody
thought the last thing said was for them, which is the same rule that produces
the silence in the first place.

## Spoken replies

Type, and the answer comes back as audio. Two settings in `.hermes/.env`:

```sh
ELEVENLABS_API_KEY=...
SPEAK_REPLIES=1
```

Both are required to count as on — a switch that silently does nothing is worse
than one that is off — and `groups status` says which half is missing. They are
read from the shell or from `.hermes/.env`, because the gateway loads that file
at import: a status that only checked the shell called the key missing while the
audio was working.

The `tts:` section in `.hermes/config.yaml` is written by `groups init` and
reconciled on every boot, so there is nothing to add by hand:

```yaml
tts:
  elevenlabs:
    model_id: eleven_flash_v2_5     # built for live conversation
```

Editing it does not stick, on purpose. `src/defaults.py` is the one place that
names a model, and `align()` points every home back at it on start.

### Voices

`src/policy/voice.py` holds ten voice ids, and in a group each agent takes one
by position in the sorted roster, so no two sound alike and the answer does not
depend on the order somebody listed them in. The browser has the same list, in
the same order, and a test fails if the two ever drift.

To see what the account actually has, and pick different ones:

```sh
curl -s "https://api.elevenlabs.io/v2/voices?page_size=100" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" | jq -r '.voices[] | "\(.voice_id)  \(.name)"'
```

The [voice library](https://elevenlabs.io/docs/api-reference/voices/search-shared)
has Spanish and Rioplatense voices — Geremias, Gustavo, Alma — and they are the
obvious fit for agents that speak that way. They need the **Creator tier**: on a
free account, asking for one returns `free_users_not_allowed` rather than
falling back to anything, so the audio is simply missing. Adding one to the
account through the dashboard is what makes it usable, and then it is an id like
any other.

Docs: [voice list](https://elevenlabs.io/docs/api-reference/voices/get-all),
[shared library](https://elevenlabs.io/docs/api-reference/voices/search-shared),
[models](https://elevenlabs.io/docs/capabilities/text-to-speech#models).

Emoji are stripped on the way to the synthesiser and nowhere else. A voice reads
them as their names — "Hola Fabri waving hand" — which is tone being pronounced
instead of felt. The written reply keeps them.

The chat client plays what comes back and marks the line with 🔊. Tests never
synthesise: the suite reading a live key from .env meant calling a paid API on
every run.

The gateway does this itself on messaging platforms, through an `auto_tts` flag
and a send pipeline that turns the file into a voice note. `api_server` never
touches TTS, so over HTTP the reply is text and nothing else; this layer
synthesises at the one place every reply already passes through, and attaches
the audio as a `MEDIA:` marker.

A turn that stays silent never gets there, so silence costs nothing on this side
either. And a missing key or a bad minute at the provider costs the audio, never
the answer: a reply you can read is worth more than one you can hear.

## Deploying

One container, and it holds everything: three gateways on 8700-8702 and the web
app in front of them. Not a choice about cost. The app reaches the agents on
`127.0.0.1` exactly as it does on a laptop, so there is no private DNS to
resolve, no bind address to get right, and no second description of the group
topology that can drift from the one the code assumes. `/api/audio` also keeps
working, because the agent's disk and the web server's disk are the same disk.

```sh
docker build -t hermes-elevenlabs .
docker run -p 3000:3000 -v hermes-data:/data \
  -e OPENROUTER_API_KEY=... -e ELEVENLABS_API_KEY=... -e SPEAK_REPLIES=1 \
  hermes-elevenlabs
```

On Railway that is the same thing with a volume mounted at `/data` and those
three as service variables. `railway.json` pins the Dockerfile builder, because
autodetection picks one runtime and this repo is Python and Node at once.

### What has to survive a deploy

`HERMES_GROUP_STATE`, read by both languages so there is one answer rather than
two that can disagree. It defaults to the repo root, which is what every path in
this project used to compute inline, and points at the volume in a container.

Under it: the three homes, `group.json`, and `.hermes/cast.json`. That last one
is why it matters. The cast is the deal of which persona each agent drew, and
without a volume every deploy re-deals it, so the same three names come back as
three different people.

`context/` and `personas/` stay in the image. They are read-only and belong to
the version that shipped, not to the state.

`SPEECH_SIGNING_SECRET` is optional and only matters beyond one instance. It
signs the proof that a line came from the room, which `/api/speak` checks before
it will read anything aloud. Unset, each process mints its own at boot and a
restart invalidates grants nobody is still holding. Set it to any long random
string when two instances serve the same room.

### Boot

`scripts/serve.sh` provisions any home the volume does not have yet, starts the
three gateways, exports `group.json` as `GROUP_AGENTS`, and `exec`s the web
server so it is PID 1 and gets the platform's SIGTERM. `group_up.py` is
idempotent, so on every boot after the first it finds three homes and leaves
them alone.

A gateway that dies is not restarted; the room reports that agent as failing and
the other two carry on.

## Working on it

`main` is protected: no direct pushes, and every change needs a PR whose `test`
check has passed. `.claude/skills/babysit` watches a PR to green, fixes lint
and test failures, reads the diff, and merges.

```sh
git checkout -b whatever
gh pr create --fill
# then: "babysit"
```

## Known rough edges

- `_transform_output` parses `REACT:`, `REPLY:`, `PROFILE:`, `PROFILEIMAGE:` and
  `METADATA:` out of the response and then discards them. Harmless over local
  HTTP; needs a decision once there is a real transport.
- Every turn carries ~50k input tokens of SOUL plus context. Fine for a local
  test, worth trimming before anything runs continuously.
- One gateway serves every chat it hosts, and they share one memory. That is
  upstream's model, not this layer's, and it is worth knowing before reading
  anything into what an agent appears to remember.
