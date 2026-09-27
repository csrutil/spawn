# pi-spawn

Non-blocking subagents for [pi](https://github.com/earendil-works/pi).

The `spawn` tool starts a subagent and returns its id at once. The main agent
keeps working. When the subagent finishes, its final summary is posted to the
main session as a message. If main is idle, the message starts a turn. If main
is busy, the message is queued (`followUp`) or injected (`steer`).

Model: io_uring-style. `spawn` is a submission. Each finished subagent produces
one completion entry. Each spawn starts immediately, with no concurrency limit.

Each subagent is a plain `Agent` from `@earendil-works/pi-agent-core` in the
same process. It gets built-in tools only, no extensions (so it cannot spawn),
and no AGENTS.md or skills. It does not see the main conversation. Only its
final summary goes back to main.

## Install

```bash
pi install git:github.com/csrutil/spawn
# or from a local clone, per run:
pi -e ./spawn/src/index.ts
```

## Tools and command

| Name | Purpose |
|---|---|
| `spawn` | `{name, task, model?, tools?, cwd?}`. Returns immediately. `model` is honored only when the user's prompt names that model; otherwise `spawn.json` applies. `name` is kebab-case and becomes the id (`-2` suffix on repeats). |
| `spawn_send` | `{id, message}`. Steers a running subagent, or starts a follow-up run of a finished one with its earlier context. The last 16 finished subagents of the session accept follow-ups. |
| `spawn_status` | Running subagents and recent completions. |
| `spawn_cancel` | `{id}` or `{id: "all"}`. Aborts running subagents. |
| `/spawn`, `/spawn cancel <id\|all>`, `/spawn log <id>` | Same, for the user. `log` shows a condensed transcript. |

A widget above the editor shows subagents as a tree:

```
● Spawn Agents 1 running · 1 failed
├─ ✗ 🦊 usd-cny-rate · error · 2 turns · 1 tool use · ↑2.6k ↓147 · $0.0012 · 3s · glm-5.3-flash:high
│   ⎿  429 rate limited
└─ ⠹ 🐙 usd-jpy-rate · 5 turns · 5 tool uses · 33.8k token (17%) · 12s · glm-5.3-flash:high
    ⎿  bash curl -s https://open.er-api.com/v6/latest/USD
```

Running rows show turns, tool uses, context tokens (and share of the context
window), elapsed time, model, and the current step. A successful row leaves once
its summary is posted; failed rows stay until the next user prompt.

## Transcripts

Each subagent's messages are appended, as they happen, to
`<session file without .jsonl>/spawn/<id>.jsonl`, e.g.
`~/.pi/agent/sessions/--Users-me-Code-proj--/2026-09-27T03-48-16-097Z_<uuid>/spawn/find-auth-code.jsonl`.
The first line is a header (task, model, cwd, tools); every other line is one
message. The path is included in the completion message, so the main agent can
read it. Ids stay unique across restarts of the same session. Sessions without
a file (`--no-session`) have no transcripts.

## File locks

The first subagent to `edit` or `write` a file claims it until that subagent
finishes. Edits to it by other subagents fail with an error naming the owner,
and the main agent's `edit`/`write` on it is blocked. The main agent is also
told not to give overlapping files to concurrent subagents, and to pass
read-only tools for research tasks.

## Config: `~/.pi/agent/spawn.json`

All fields are optional.

```json
{
  "model": null,
  "thinkingLevel": null,
  "tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "deliverAs": "followUp",
  "summaryTokens": 1000,
  "timeout": 600
}
```

- `model`: default subagent model. `"provider/id"` or a bare `"id"`, optionally with `":level"` (e.g. `"gpt-5.6-luna:high"`). A bare id found under several providers prefers the main session's provider, then providers with auth. `null` uses the main session's current model. The `SPAWN_MODEL` env var overrides it, in the same format (e.g. `SPAWN_MODEL=gpt-5.6-luna:high pi`).
- `thinkingLevel`: `null` uses the main session's level. Clamped to the model.
- `tools`: upper bound. A `spawn` call can request a subset. `null` or omitted means all built-in tools (read, bash, edit, write, grep, find, ls).
- `summaryTokens`: the summary sent to the main session is cut at about this many tokens (estimated as 4 chars per token).
- `timeout`: seconds per subagent. `0` disables the timeout.

Config is read at session start. Use `/reload` after editing.

## Development

```bash
npm run check   # biome + tsc
npm test        # node:test: registry, widget, transcripts, worker (faux model)
```
