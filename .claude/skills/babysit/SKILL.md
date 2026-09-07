---
name: babysit
description: |
  Watch a PR's CI to completion, fix what fails, and merge it once everything
  is green. USE WHEN: the user says "babysit", "watch ci", "merge when
  green", "wait for CI", or asks to keep an eye on a PR until it can land.
---

`main` is protected, so every change arrives through a PR and every PR waits on
one check. This watches that check, fixes what it catches, and merges — without
asking again at each step, because asking for this skill is the answer.

## Resolve the PR

An argument may be a number or a branch. With neither, use the current branch:

```sh
gh pr view [<number-or-branch>] --json number,title,state,isDraft,mergeable,headRefOid
```

No open PR is where this stops. So is a draft: CI does not run on one, and
flipping it to ready is a decision the user makes, not this skill.

## Wait

One check, `test`: `uv sync --frozen`, `ruff`, then the suite minus the live
tests. It takes about thirty seconds, so poll on that scale rather than in
minutes.

```sh
until [ "$(gh pr checks <num> --json state --jq '.[0].state')" != "IN_PROGRESS" ]; do sleep 15; done
gh pr checks <num>
```

Two traps in that loop, both already hit here:

- Right after a push there are **no checks at all** for a few seconds, and
  `gh pr checks` says "no checks reported" rather than pending. Treat an empty
  result as not-yet-started, not as done.
- A new push **cancels** the run in flight, so a `cancelled` conclusion on an
  older SHA is noise. Every state you act on must be read against the current
  `headRefOid`.

## On red

Read the failing step before touching anything:

```sh
gh run view --log-failed
```

This repo's CI has exactly two ways to fail, and both reproduce locally in
seconds — which is the whole reason to reproduce rather than guess:

| Failure | Do |
|---|---|
| `ruff` | `uv run ruff check --fix .`, then read the diff. It is usually an import left behind by moving code. |
| `pytest` | `pnpm test:unit` locally. If it passes locally and fails in CI, the difference is almost always something the test reads from the machine — an env var, a path, a key in `.hermes/.env` that CI does not have. |

A test that fails only in CI is a test coupled to this machine, and the fix
belongs in the test.

**Two fix commits, then stop.** If it is still red after that, say what failed,
what was tried, and what is still unexplained. A third guess is not debugging.

## Before merging, read the diff

CI proves the tests pass. It does not prove the change is right, and this skill
is the last thing between a branch and `main`.

```sh
gh pr diff <num>
```

Worth a second look, because each has already gone in here and been caught
afterwards: a secret or an absolute path under someone's home in a committed
file; a status line that reports success on a setting that is empty; a check
whose probe changes the thing it measures. If something looks wrong, say so and
stop — a green check is not a review.

## Merge

```sh
gh pr merge <num> --squash --delete-branch
```

Squash, because `main` requires linear history. Then confirm it landed and say
what it cost — wall time, and any reruns or fix commits it took to get there.
