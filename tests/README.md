# Tests

Three sides, three folders, one tree.

| | what it covers | run |
|---|---|---|
| `runtime/` | one agent, one turn: the context it is given, the plugin that injects it, the policy that decides whether it speaks, the markers it writes, the state it persists | `pnpm test:unit` |
| `harness/` | what stands the group up and hands it a room: the agents, the roster, the personas, the config a home is written with | `pnpm test:unit` |
| `web/` | the browser client: what a room reads back out of a session, and who each agent is told it is | `pnpm --dir web test` |
| `live/` | needs three gateways actually answering; skipped otherwise | `pnpm test` |

The split is by what a test is about, not by where the code happens to live.
`policy/outbound_length` and `lib/persistent` sit in different packages and are
both runtime, because both only ever run inside an agent mid-turn.

`web/` is TypeScript and runs under vitest rather than pytest; that is the only
difference, and it is a difference of language, not of organisation.
