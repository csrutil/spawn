# pi-spawn

Non-blocking subagents for [pi](https://github.com/earendil-works/pi).

The `spawn` tool starts a subagent and returns its id at once. The main agent
keeps working. When the subagent finishes, its final summary is posted to the
main session as a message. If main is idle, the message starts a turn. If main
is busy, the message is queued (`followUp`) or injected (`steer`).

Model: io_uring-style. `spawn` is a submission. Each finished subagent produces
one completion entry. There is no wait queue: at most `maxInFlight` (max 64)
subagents run at once, and `spawn` fails with `EAGAIN` beyond that.

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
| `spawn_status` | Running subagents and recent completions. |
| `spawn_cancel` | `{id}` or `{id: "all"}`. |
| `/spawn`, `/spawn cancel <id\|all>` | Same, for the user. |

A widget above the editor lists subagents. Running rows show elapsed time,
turn, and current tool. Finished rows stay until the next user prompt.

## Config: `~/.pi/agent/spawn.json`

All fields are optional.

```json
{
  "maxInFlight": 64,
  "model": null,
  "thinkingLevel": null,
  "tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "deliverAs": "followUp",
  "maxSummaryChars": 4000,
  "timeoutMs": 600000
}
```

- `model`: default subagent model. `"provider/id"` or a bare `"id"`, optionally with `":level"` (e.g. `"gpt-5.6-luna:high"`). A bare id found under several providers prefers the main session's provider, then providers with auth. `null` uses the main session's current model.
- `thinkingLevel`: `null` uses the main session's level. Clamped to the model.
- `tools`: upper bound. A `spawn` call can request a subset. `null` or omitted means all built-in tools (read, bash, edit, write, grep, find, ls).
- `timeoutMs`: `0` disables the timeout.

Config is read at session start. Use `/reload` after editing.

## Development

```bash
npm run check   # biome + tsc
npm test        # node:test unit tests for the in-flight registry
```
