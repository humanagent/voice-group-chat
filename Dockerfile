# One image, one container, everything in it.
#
# The web app reaches the agents on 127.0.0.1, exactly as it does on a laptop,
# and that is the whole reason this is one service rather than four: no private
# DNS to resolve, no bind address to get right, no group topology described in
# an environment variable that can disagree with the one the code assumes. What
# runs here is what was tested there.
#
# The cost is this file. A platform that autodetects a runtime picks one, and
# this repo is Python and Node at once.
#
# Three stages, because layers are additive and deleting in a later one does not
# shrink an earlier one. A single stage that installed the dev dependencies,
# built with them and then pruned them still shipped every byte: measured at
# 4.72GB against the 1.77GB below.

# ── the Python side ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS python

# `python3` is 3.11 on bookworm, which is what `.python-version` asks for, and
# `only-system` holds uv to it. Left to choose, uv downloads a standalone
# CPython into a cache directory that the runtime stage does not have, and the
# venv copied out of here points at an interpreter that is not there.
ENV UV_NO_CACHE=1 \
    UV_PYTHON_PREFERENCE=only-system

# `git` is not a convenience: pyproject pulls upstream Hermes from a git tag.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11.9 /uv /usr/local/bin/uv

WORKDIR /app

# Dependencies before source, so editing the app does not re-resolve the tree.
# `--frozen` for the same reason CI uses it: the lockfile is the answer, not a
# starting point. `--no-dev`, or the venv carries the type checker, and
# basedpyright pulls a whole second Node runtime through nodejs_wheel.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY . .
RUN uv sync --frozen --no-dev

# ── the web side ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS web

WORKDIR /app

COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./web/
RUN corepack enable && cd web && pnpm install --frozen-lockfile

COPY . .

# The build needs the dev dependencies; what runs afterwards does not. Pruned
# here so the next stage copies what is left rather than what was installed.
RUN cd web && pnpm build && pnpm prune --prod

# ── what actually runs ───────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# No uv and no git down here. The venv is built; running it needs an
# interpreter and nothing else.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .
COPY --from=python /app/.venv ./.venv
COPY --from=web /app/web/.next ./web/.next
COPY --from=web /app/web/node_modules ./web/node_modules

# The volume. Homes, `group.json` and the drawn cast live here and survive a
# deploy; everything else in this image is replaced by one. Both languages read
# the same variable, on purpose, so there is one answer to where the state is.
ENV HERMES_GROUP_STATE=/data \
    NODE_ENV=production \
    PORT=3000

EXPOSE 3000
CMD ["scripts/serve.sh"]
