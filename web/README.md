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

`/api/audio` only serves files under the agents' own Hermes homes, resolved
through symlinks before comparing. Deployed there are no such files and it
returns 404, and the room falls back to marking the line as spoken.
