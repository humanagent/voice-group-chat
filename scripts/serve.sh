#!/bin/sh
# The container's one process tree: three gateways, then the web app in front.
#
# The venv directly rather than through `uv`: the image has a built environment
# and no resolver, and `uv run` would try to sync one that is already correct.
#
# Order matters. `group_up.py` is idempotent, so this runs on every boot and
# does nothing on most of them: an agent whose home is already on the volume
# keeps its memory, its drawn persona and its key, and only a volume that has
# never been written provisions from scratch.
set -eu

STATE="${HERMES_GROUP_STATE:-/data}"

# `.hermes/` is where the cast is written. It is the single-agent runtime's home
# locally and there is no such runtime here, but the directory has to exist for
# the deal to be recorded rather than re-dealt on every deploy.
mkdir -p "$STATE/.hermes"

.venv/bin/python scripts/group_up.py ${GROUP_NAMES:-Anna Jordan Pepe}

# The file the terminal client reads, handed to the web app the way a deploy
# already expected to receive it. Not a second format: `group.json` records a
# port and `normalise` turns that into a localhost URL, which here is true.
GROUP_AGENTS="$(cat "$STATE/group.json")"
export GROUP_AGENTS

# `exec`, so the web server is PID 1 and gets the platform's SIGTERM directly.
# The gateways are its siblings and go down with the container.
cd web
exec node_modules/.bin/next start -p "${PORT:-3000}"
