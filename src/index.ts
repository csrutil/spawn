/**
 * spawn: non-blocking subagents for pi.
 *
 * The `spawn` tool starts a subagent (a plain pi Agent in this process) and
 * returns its id at once. The main agent keeps working. When the subagent
 * finishes, its final summary is posted to the main session as a
 * "spawn-cqe" custom message, which starts or queues a turn.
 */

import { clampThinkingLevel, StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  configPath,
  loadConfig,
  type SpawnConfig,
  type SubagentToolName,
  TOOL_NAMES,
} from "./config.ts";
import { PURE_SLEEP } from "./guard.ts";
import { type Completion, Ring, slugName } from "./ring.ts";
import { EMOJIS, type Row, SpawnWidget, tokens } from "./widget.ts";
import { runSubagent } from "./worker.ts";

const CQE_TYPE = "spawn-cqe";

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function cqeContent(c: Completion): string {
  const head = `[spawn ${c.id} ${c.status} after ${seconds(c.endedAt - c.startedAt)}, ${c.turns} turns]`;
  const error = c.error ? `\nerror: ${c.error}` : "";
  const body = c.summary ? `\n${c.summary}` : "\n(no summary)";
  return `${head}${error}${body}`;
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export default function spawnExtension(pi: ExtensionAPI) {
  let config: SpawnConfig = loadConfig().config;
  let ctxRef: ExtensionContext | undefined;
  let active = false;

  // Widget rows: running subagents plus finished ones since the last user
  // prompt.
  const rows = new Map<string, Row>();
  // Display-only info per subagent id.
  const meta = new Map<string, { emoji: string; model: string }>();
  let emojiIndex = 0;
  let tui: TUI | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const refreshView = () => {
    const running = [...rows.values()].some((r) => !r.completion);
    if (running && !ticker) {
      ticker = setInterval(() => tui?.requestRender(), 100);
    } else if (!running && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
    if (!ctxRef?.hasUI) return;
    if (rows.size === 0) {
      ctxRef.ui.setWidget("spawn", undefined);
      tui = undefined;
    } else if (!tui) {
      ctxRef.ui.setWidget("spawn", (t, theme) => {
        tui = t;
        return new SpawnWidget(() => [...rows.values()], theme);
      });
    } else {
      tui.requestRender();
    }
  };

  const deliver = (c: Completion) => {
    const row = rows.get(c.id);
    if (row) row.completion = c;
    refreshView();
    if (!active) return;
    pi.sendMessage(
      {
        customType: CQE_TYPE,
        content: cqeContent(c),
        display: true,
        details: { ...c, ...meta.get(c.id) },
      },
      { triggerTurn: true, deliverAs: config.deliverAs },
    );
  };

  let ring = new Ring({
    limit: config.maxInFlight,
    timeoutMs: config.timeoutMs,
    historySize: 64,
    onComplete: deliver,
  });

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    active = true;
    const loaded = loadConfig();
    config = loaded.config;
    for (const w of loaded.warnings) ctx.ui.notify(`spawn: ${w}`, "warning");
    ring.cancel("all");
    ring = new Ring({
      limit: config.maxInFlight,
      timeoutMs: config.timeoutMs,
      historySize: 64,
      onComplete: deliver,
    });
    rows.clear();
    meta.clear();
    tui = undefined;
    refreshView();
  });

  // Models tend to `sleep` to wait for subagents. Waiting is never needed:
  // completions start a new turn. Block a bash call that only sleeps and end
  // the turn so the user can keep talking.
  pi.on("tool_call", async (event) => {
    if (ring.size === 0 || !isToolCallEventType("bash", event)) return;
    if (!PURE_SLEEP.test(event.input.command)) return;
    return {
      block: true,
      terminate: true,
      reason:
        `${ring.size} subagent(s) running. Do not sleep to wait for them: ` +
        "each summary arrives as a new message and starts a new turn. " +
        "End your turn now with a short note of what is running.",
    };
  });

  // A new user prompt clears finished rows. Running rows stay.
  pi.on("input", async () => {
    for (const [id, row] of rows) if (row.completion) rows.delete(id);
    refreshView();
  });

  pi.on("session_shutdown", async () => {
    active = false;
    ring.cancel("all");
    rows.clear();
    refreshView();
  });

  pi.registerTool({
    name: "spawn",
    label: "Spawn",
    description:
      "Start a background subagent for a self-contained task. Returns its name immediately; does not wait. " +
      "When the subagent finishes, its summary arrives later as a separate message. " +
      `At most ${config.maxInFlight} subagents run at once; beyond that the call fails with EAGAIN.`,
    promptSnippet: "Start a non-blocking background subagent",
    promptGuidelines: [
      "Use spawn for independent tasks that can run in parallel; keep working instead of waiting.",
      "Subagents do not see this conversation. Put all needed context, paths, and the expected output in the task.",
      "Never wait for subagents: no sleep, no polling spawn_status. Each summary arrives as a new message and starts a new turn.",
      "After spawning, do other work or end your turn with a short note of what is running. The user can keep talking meanwhile.",
      "Give each subagent a short kebab-case name that says what it does, e.g. find-auth-code or review-parser-tests.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          "Short kebab-case name describing the job (2-4 words), e.g. find-auth-code. Used as the subagent id.",
      }),
      task: Type.String({
        description: "Full, self-contained instructions for the subagent",
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Model as "provider/modelId". Default: spawn.json model, else current model',
        }),
      ),
      tools: Type.Optional(
        Type.Array(StringEnum(TOOL_NAMES), {
          description: "Subset of allowed tools. Default: spawn.json tools",
        }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Working directory. Default: current cwd" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        details: { error: text },
      });

      const modelSpec = params.model ?? config.model;
      let model = ctx.model;
      if (modelSpec) {
        const slash = modelSpec.indexOf("/");
        model =
          slash > 0
            ? ctx.modelRegistry.find(
                modelSpec.slice(0, slash),
                modelSpec.slice(slash + 1),
              )
            : undefined;
        if (!model) return fail(`spawn: unknown model "${modelSpec}"`);
      }
      if (!model) return fail("spawn: no model selected");

      const allowed = new Set<SubagentToolName>(config.tools);
      const tools = (params.tools ?? config.tools).filter((t) =>
        allowed.has(t),
      );
      const cwd = params.cwd ?? ctx.cwd;
      const thinkingLevel = clampThinkingLevel(
        model,
        config.thinkingLevel ?? pi.getThinkingLevel(),
      );
      const modelLabel = `${model.id}:${thinkingLevel}`;
      const { modelRegistry } = ctx;
      const resolvedModel = model;

      const result = ring.submit(
        { name: params.name, task: params.task },
        (signal, id) => {
          const emoji = EMOJIS[emojiIndex++ % EMOJIS.length];
          meta.set(id, { emoji, model: modelLabel });
          const row: Row = {
            id,
            emoji,
            model: modelLabel,
            startedAt: Date.now(),
            turns: 0,
            activity: "starting",
          };
          rows.set(id, row);
          refreshView();
          return runSubagent(
            {
              task: params.task,
              cwd,
              model: resolvedModel,
              thinkingLevel,
              tools,
              modelRegistry,
              maxSummaryChars: config.maxSummaryChars,
              onProgress: (p) => {
                row.turns = p.turns;
                row.activity = p.activity;
              },
            },
            signal,
          );
        },
      );

      if (!result.ok) {
        return fail(
          `EAGAIN: ${result.inFlight}/${result.limit} subagents in flight. ` +
            "Wait for a completion or cancel one with spawn_cancel.",
        );
      }
      return {
        content: [
          {
            type: "text",
            text: `spawned ${result.id} (${modelLabel}). Do not wait or sleep: continue other work or end your turn. The summary arrives as a new message.`,
          },
        ],
        details: {
          id: result.id,
          ...meta.get(result.id),
        },
      };
    },

    renderCall(args, theme) {
      const name = args.name ? slugName(args.name, args.task ?? "") : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("spawn "))}${theme.fg("accent", name)} ${theme.fg("dim", oneLine(args.task ?? "", 100))}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const d = result.details as
        | { id?: string; emoji?: string; model?: string; error?: string }
        | undefined;
      if (d?.error) return new Text(theme.fg("error", d.error), 0, 0);
      if (!d?.id) return new Text("", 0, 0);
      return new Text(
        theme.fg("dim", `→ ${d.emoji ?? ""} ${d.id} running on ${d.model}`),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "spawn_status",
    label: "Spawn Status",
    description: "List running subagents and recent completions.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text:
              ring.size > 0
                ? `${statusText()}\nDo not poll or sleep. End your turn if nothing else to do; summaries arrive as new messages.`
                : statusText(),
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "spawn_cancel",
    label: "Spawn Cancel",
    description: 'Abort a running subagent by id, or "all".',
    parameters: Type.Object({
      id: Type.String({ description: 'Subagent id (e.g. "s3") or "all"' }),
    }),
    async execute(_toolCallId, params) {
      const n = ring.cancel(params.id);
      return {
        content: [
          {
            type: "text",
            text:
              n > 0
                ? `cancelled ${n} subagent(s)`
                : `no running subagent "${params.id}"`,
          },
        ],
        details: { cancelled: n },
      };
    },
  });

  const statusText = (): string => {
    const now = Date.now();
    const running = ring.running();
    const done = ring.completed().slice(-10);
    const lines = [`running ${running.length}/${config.maxInFlight}`];
    for (const t of running)
      lines.push(`  ${t.id} ${seconds(now - t.startedAt)}: ${oneLine(t.task)}`);
    if (done.length > 0) lines.push("recent completions:");
    for (const c of done)
      lines.push(`  ${c.id} ${c.status} ${seconds(c.endedAt - c.startedAt)}`);
    return lines.join("\n");
  };

  pi.registerCommand("spawn", {
    description: `Show subagents. "/spawn cancel <id|all>" aborts. Config: ${configPath()}`,
    handler: async (args, ctx) => {
      const [sub, id] = args.trim().split(/\s+/);
      if (sub === "cancel") {
        const n = ring.cancel(id ?? "all");
        ctx.ui.notify(`spawn: cancelled ${n}`, "info");
        return;
      }
      ctx.ui.notify(statusText(), "info");
    },
  });

  pi.registerMessageRenderer<Completion & { emoji?: string; model?: string }>(
    CQE_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const c = message.details;
      if (!c) return undefined;
      const color =
        c.status === "ok"
          ? "success"
          : c.status === "error"
            ? "error"
            : "warning";
      let text =
        `${theme.fg(color, "spawn")} ${c.emoji ? `${c.emoji} ` : ""}${theme.bold(c.id)} ` +
        theme.fg(
          "dim",
          `${c.status} · ${seconds(c.endedAt - c.startedAt)} · ${c.turns} turns · ${c.model ? `${c.model} ` : ""}↑${tokens(c.usage.input)} ↓${tokens(c.usage.output)}`,
        );
      if (c.error) text += `\n${theme.fg("error", c.error)}`;
      text += expanded
        ? `\n${c.summary || "(no summary)"}`
        : `\n${theme.fg("dim", oneLine(c.summary || "(no summary)", 120))}`;
      const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(text, 0, 0));
      return box;
    },
  );
}
