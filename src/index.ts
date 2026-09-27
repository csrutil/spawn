/**
 * spawn: non-blocking subagents for pi.
 *
 * The `spawn` tool starts a subagent (a plain pi Agent in this process) and
 * returns its id at once. The main agent keeps working. When the subagent
 * finishes, its final summary is posted to the main session as a
 * "spawn-cqe" custom message, which starts or queues a turn.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type Api,
  clampThinkingLevel,
  type Model,
  StringEnum,
} from "@earendil-works/pi-ai";
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
import { resolveModel, userNamedModel } from "./model.ts";
import { type Completion, Ring, type SubmitResult, slugName } from "./ring.ts";
import {
  formatTranscript,
  readTranscript,
  Transcript,
  transcriptDir,
  transcriptIds,
} from "./transcript.ts";
import {
  cost,
  EMOJIS,
  FRAME_MS,
  type Row,
  SpawnWidget,
  tokens,
} from "./widget.ts";
import { Subagent } from "./worker.ts";

const CQE_TYPE = "spawn-cqe";
/** Finished subagents kept in memory for spawn_send follow-ups. */
const MAX_RETAINED = 16;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function cqeContent(c: Completion, transcript?: string): string {
  const head = `[spawn ${c.id} ${c.status} after ${seconds(c.endedAt - c.startedAt)}, ${c.turns} turns]`;
  const error = c.error ? `\nerror: ${c.error}` : "";
  const log = transcript ? `\ntranscript: ${transcript}` : "";
  const body = c.summary ? `\n${c.summary}` : "\n(no summary)";
  return `${head}${error}${log}${body}`;
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function absPath(path: string, cwd: string): string {
  return resolve(cwd, path.replace(/^~(?=$|\/)/, homedir()));
}

interface Meta {
  emoji: string;
  model: string;
  contextWindow: number;
  transcript?: string;
}

export default function spawnExtension(pi: ExtensionAPI) {
  let config: SpawnConfig = loadConfig().config;
  let ctxRef: ExtensionContext | undefined;
  let active = false;
  // Latest user prompt; decides whether a spawn model argument is honored.
  let lastUserText = "";
  // `<session>/spawn`, or undefined for in-memory sessions.
  let logDir: string | undefined;

  // Widget rows: running subagents, plus failed ones since the last user
  // prompt. Successful ones leave as soon as their message is posted.
  const rows = new Map<string, Row>();
  // Display-only info per subagent id.
  const meta = new Map<string, Meta>();
  // Live and recently finished subagents, for follow-ups. Insertion order is
  // age order.
  const agents = new Map<string, Subagent>();
  // Absolute path -> id of the running subagent that changed it.
  const claims = new Map<string, string>();
  let emojiIndex = 0;
  let tui: TUI | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const refreshView = () => {
    const running = [...rows.values()].some((r) => !r.completion);
    if (running && !ticker) {
      ticker = setInterval(() => tui?.requestRender(), FRAME_MS);
    } else if (!running && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
    if (!ctxRef?.hasUI) return;
    if (rows.size === 0 && ring.queued().length === 0) {
      ctxRef.ui.setWidget("spawn", undefined);
      tui = undefined;
    } else if (!tui) {
      ctxRef.ui.setWidget("spawn", (t, theme) => {
        tui = t;
        return new SpawnWidget(
          () => [...rows.values()],
          () => ring.queued().length,
          theme,
        );
      });
    } else {
      tui.requestRender();
    }
  };

  const release = (id: string) => {
    for (const [path, owner] of claims) if (owner === id) claims.delete(path);
  };

  const retain = () => {
    const finished = [...agents.keys()].filter((id) => !ring.isActive(id));
    for (const id of finished.slice(0, -MAX_RETAINED)) agents.delete(id);
  };

  const deliver = (c: Completion) => {
    release(c.id);
    retain();
    const m = meta.get(c.id);
    const row = rows.get(c.id);
    if (row) row.completion = c;
    if (active && c.status === "ok") rows.delete(c.id);
    refreshView();
    if (!active) return;
    pi.sendMessage(
      {
        customType: CQE_TYPE,
        content: cqeContent(c, m?.transcript),
        display: true,
        details: { ...c, ...m },
      },
      { triggerTurn: true, deliverAs: config.deliverAs },
    );
  };

  // Completions from a previous session's ring are dropped.
  const makeRing = (reserved: string[] = []): Ring => {
    const r: Ring = new Ring({
      limit: config.maxInFlight,
      queueLimit: config.maxQueued,
      timeout: config.timeout,
      historySize: 64,
      reserved,
      onComplete: (c) => {
        if (r === ring) deliver(c);
      },
    });
    return r;
  };
  let ring = makeRing();

  /** Runner for one run under `id`: gets the subagent, adds a row, runs. */
  const runner =
    (sub: (id: string) => Subagent, text: string) =>
    (signal: AbortSignal, id: string) => {
      const agent = sub(id);
      const m = meta.get(id);
      const row: Row = {
        id,
        emoji: m?.emoji ?? "",
        model: m?.model ?? "",
        startedAt: Date.now(),
        turns: 0,
        toolUses: 0,
        contextTokens: rows.get(id)?.contextTokens ?? 0,
        contextWindow: m?.contextWindow ?? 0,
        activity: "starting",
      };
      rows.set(id, row);
      refreshView();
      agent.onProgress = (p) => {
        row.turns = p.turns;
        row.toolUses = p.toolUses;
        row.contextTokens = p.contextTokens;
        row.activity = p.activity;
      };
      return agent.run(text, signal);
    };

  const eagain = (r: Extract<SubmitResult, { ok: false }>) =>
    `EAGAIN: ${r.inFlight}/${r.limit} subagents in flight and ${r.queued} queued. ` +
    "Wait for a completion or cancel one with spawn_cancel.";

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    active = true;
    const loaded = loadConfig();
    config = loaded.config;
    for (const w of loaded.warnings) ctx.ui.notify(`spawn: ${w}`, "warning");
    ring.cancel("all");
    logDir = transcriptDir(ctx.sessionManager.getSessionFile());
    // Ids stay unique across restarts of the same session.
    ring = makeRing(transcriptIds(logDir));
    rows.clear();
    meta.clear();
    agents.clear();
    claims.clear();
    tui = undefined;
    refreshView();
  });

  pi.on("tool_call", async (event, ctx) => {
    // The main agent must not edit a file a running subagent is changing.
    if (
      isToolCallEventType("edit", event) ||
      isToolCallEventType("write", event)
    ) {
      const owner = claims.get(absPath(event.input.path, ctx.cwd));
      if (!owner) return;
      return {
        block: true,
        reason:
          `Subagent "${owner}" is changing ${event.input.path}. ` +
          "Wait for its summary, or cancel it with spawn_cancel, before editing this file.",
      };
    }
    // Models tend to `sleep` to wait for subagents. Waiting is never needed:
    // completions start a new turn. Block a bash call that only sleeps and
    // end the turn so the user can keep talking.
    if (ring.size === 0 || !isToolCallEventType("bash", event)) return;
    if (!PURE_SLEEP.test(event.input.command)) return;
    return {
      block: true,
      terminate: true,
      reason:
        `${ring.size} subagent(s) running or queued. Do not sleep to wait for them: ` +
        "each summary arrives as a new message and starts a new turn. " +
        "End your turn now with a short note of what is running.",
    };
  });

  // A new user prompt clears finished rows. Running rows stay.
  pi.on("input", async (event) => {
    lastUserText = event.text;
    for (const [id, row] of rows) if (row.completion) rows.delete(id);
    refreshView();
  });

  pi.on("session_shutdown", async () => {
    active = false;
    ring.cancel("all");
    rows.clear();
    agents.clear();
    claims.clear();
    refreshView();
  });

  pi.registerTool({
    name: "spawn",
    label: "Spawn",
    description:
      "Start a background subagent for a self-contained task. Returns its name immediately; does not wait. " +
      "When the subagent finishes, its summary arrives later as a separate message. " +
      `At most ${config.maxInFlight} subagents run at once; more wait in a queue of ${config.maxQueued}. Beyond that the call fails with EAGAIN.`,
    promptSnippet: "Start a non-blocking background subagent",
    promptGuidelines: [
      "Use spawn for independent tasks that can run in parallel; keep working instead of waiting.",
      "Subagents do not see this conversation. Put all needed context, paths, and the expected output in the task.",
      "Never wait for subagents: no sleep, no polling spawn_status. Each summary arrives as a new message and starts a new turn.",
      "After spawning, do other work or end your turn with a short note of what is running. The user can keep talking meanwhile.",
      "Give each subagent a short kebab-case name that says what it does, e.g. find-auth-code or review-parser-tests.",
      'For research or review tasks, pass tools: ["read", "grep", "find", "ls"] so the subagent cannot change files.',
      "Never give two concurrent subagents tasks that change the same files. A file changed by a running subagent is locked for others and for you.",
      "To ask a subagent a follow-up or correct it, use spawn_send instead of spawning a new one; it keeps its context.",
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
            'Only when the user names a model for the subagent; otherwise omit. Ignored unless the user\'s prompt contains it. "provider/id" or "id", optional ":level".',
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

      const resolveOptions = {
        preferProvider: ctx.model?.provider,
        hasAuth: (m: Model<Api>) => ctx.modelRegistry.hasConfiguredAuth(m),
      };
      let model = ctx.model;
      let specLevel: ThinkingLevel | undefined;
      let note = "";

      // The model argument counts only when the user's prompt names that
      // model. Models tend to pass their own name, which would override
      // spawn.json.
      const requested = params.model?.trim();
      let useRequested = false;
      if (requested) {
        const r = resolveModel(
          requested,
          ctx.modelRegistry.getAll(),
          resolveOptions,
        );
        if (r.ok && userNamedModel(lastUserText, requested, r.model)) {
          model = r.model;
          specLevel = r.level;
          useRequested = true;
        } else if (
          !r.ok &&
          userNamedModel(lastUserText, requested, {
            provider: "",
            id: "",
          })
        ) {
          return fail(r.error);
        } else {
          note = ` Model "${requested}" ignored: the user did not name it; using the configured default.`;
        }
      }
      if (!useRequested && config.model) {
        const r = resolveModel(
          config.model,
          ctx.modelRegistry.getAll(),
          resolveOptions,
        );
        if (!r.ok) return fail(r.error);
        model = r.model;
        specLevel = r.level;
      }
      if (!model) return fail("spawn: no model selected");

      const allowed = new Set<SubagentToolName>(config.tools);
      const tools = (params.tools ?? config.tools).filter((t) =>
        allowed.has(t),
      );
      const cwd = params.cwd ?? ctx.cwd;
      const thinkingLevel = clampThinkingLevel(
        model,
        specLevel ?? config.thinkingLevel ?? pi.getThinkingLevel(),
      );
      const modelLabel = `${model.id}:${thinkingLevel}`;
      const { modelRegistry } = ctx;
      const resolvedModel = model;
      const dir = logDir;

      const describe = (id: string) => {
        if (!meta.has(id))
          meta.set(id, {
            emoji: EMOJIS[emojiIndex++ % EMOJIS.length],
            model: modelLabel,
            contextWindow: resolvedModel.contextWindow,
            transcript: dir ? join(dir, `${id}.jsonl`) : undefined,
          });
        return meta.get(id) as Meta;
      };

      // Runs when the subagent leaves the queue, possibly inside submit().
      const create = (id: string) => {
        const path = describe(id).transcript;
        const transcript = path ? new Transcript(path) : undefined;
        transcript?.append({
          type: "header",
          id,
          task: params.task,
          model: `${resolvedModel.provider}/${modelLabel}`,
          cwd,
          tools,
          startedAt: Date.now(),
        });
        const sub = new Subagent({
          cwd,
          model: resolvedModel,
          thinkingLevel,
          tools,
          modelRegistry,
          summaryTokens: config.summaryTokens,
          transcript,
          claim: (path) => {
            const owner = claims.get(path);
            if (owner && owner !== id && ring.isActive(owner)) return owner;
            claims.set(path, id);
            return undefined;
          },
        });
        agents.set(id, sub);
        return sub;
      };

      const result = ring.submit(
        { name: params.name, task: params.task },
        runner(create, params.task),
      );
      if (!result.ok) return fail(eagain(result));
      describe(result.id);

      const state = result.queued ? "queued" : "spawned";
      return {
        content: [
          {
            type: "text",
            text: `${state} ${result.id} (${modelLabel}).${note} Do not wait or sleep: continue other work or end your turn. The summary arrives as a new message.`,
          },
        ],
        details: {
          id: result.id,
          queued: result.queued,
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
        | {
            id?: string;
            emoji?: string;
            model?: string;
            queued?: boolean;
            error?: string;
          }
        | undefined;
      if (d?.error) return new Text(theme.fg("error", d.error), 0, 0);
      if (!d?.id) return new Text("", 0, 0);
      return new Text(
        theme.fg(
          "dim",
          `→ ${d.emoji ?? ""} ${d.id} ${d.queued ? "queued" : "running"} on ${d.model}`,
        ),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "spawn_send",
    label: "Spawn Send",
    description:
      "Send a message to a subagent by id. A running subagent sees it before its next model call. " +
      "A finished subagent starts a new run with its previous context; its reply arrives as a new message.",
    parameters: Type.Object({
      id: Type.String({ description: "Subagent id, e.g. find-auth-code" }),
      message: Type.String({
        description: "Follow-up question or correction",
      }),
    }),
    async execute(_toolCallId, params) {
      const reply = (text: string, error = false) => ({
        content: [{ type: "text" as const, text }],
        details: error ? { error: text } : { id: params.id },
      });
      const sub = agents.get(params.id);
      const running = ring.running().some((t) => t.id === params.id);
      if (running && sub) {
        sub.steer(params.message);
        return reply(`sent to running subagent ${params.id}.`);
      }
      if (ring.isActive(params.id))
        return reply(
          `${params.id} is still queued; send once it starts.`,
          true,
        );
      if (!sub)
        return reply(
          `no subagent "${params.id}" in memory. Only the last ${MAX_RETAINED} finished subagents of this session accept follow-ups; spawn a new one instead.`,
          true,
        );
      const r = ring.resume(
        params.id,
        params.message,
        runner(() => sub, params.message),
      );
      if (!r) return reply(`cannot resume ${params.id}.`, true);
      if (!r.ok) return reply(eagain(r), true);
      return reply(
        `${r.queued ? "queued" : "resumed"} ${params.id}. Do not wait or sleep; the reply arrives as a new message.`,
      );
    },
  });

  pi.registerTool({
    name: "spawn_status",
    label: "Spawn Status",
    description: "List running and queued subagents and recent completions.",
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
    description: 'Abort a running or queued subagent by id, or "all".',
    parameters: Type.Object({
      id: Type.String({
        description: 'Subagent id (e.g. "find-auth-code") or "all"',
      }),
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
                : `no running or queued subagent "${params.id}"`,
          },
        ],
        details: { cancelled: n },
      };
    },
  });

  const statusText = (): string => {
    const now = Date.now();
    const running = ring.running();
    const queued = ring.queued();
    const done = ring.completed().slice(-10);
    const lines = [
      `running ${running.length}/${config.maxInFlight}, queued ${queued.length}/${config.maxQueued}`,
    ];
    for (const t of running)
      lines.push(`  ${t.id} ${seconds(now - t.startedAt)}: ${oneLine(t.task)}`);
    for (const t of queued) lines.push(`  ${t.id} queued: ${oneLine(t.task)}`);
    if (done.length > 0) lines.push("recent completions:");
    for (const c of done)
      lines.push(`  ${c.id} ${c.status} ${seconds(c.endedAt - c.startedAt)}`);
    if (logDir) lines.push(`transcripts: ${logDir}`);
    return lines.join("\n");
  };

  pi.registerCommand("spawn", {
    description: `Show subagents. "/spawn cancel <id|all>" aborts, "/spawn log <id>" shows a transcript. Config: ${configPath()}`,
    handler: async (args, ctx) => {
      const [sub, id] = args.trim().split(/\s+/);
      if (sub === "cancel") {
        const n = ring.cancel(id ?? "all");
        ctx.ui.notify(`spawn: cancelled ${n}`, "info");
        return;
      }
      if (sub === "log") {
        if (!logDir) {
          ctx.ui.notify(
            "spawn: this session has no file, so no transcripts",
            "warning",
          );
          return;
        }
        const path = id ? join(logDir, `${id}.jsonl`) : undefined;
        const text = path ? readTranscript(path) : undefined;
        if (!path || text === undefined) {
          const ids = transcriptIds(logDir);
          ctx.ui.notify(
            `spawn: usage /spawn log <id>. Transcripts: ${ids.join(", ") || "none"}`,
            "warning",
          );
          return;
        }
        ctx.ui.notify(
          [...formatTranscript(text), `file: ${path}`].join("\n"),
          "info",
        );
        return;
      }
      ctx.ui.notify(statusText(), "info");
    },
  });

  pi.registerMessageRenderer<Completion & Partial<Meta>>(
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
      const stats = [
        c.status,
        seconds(c.endedAt - c.startedAt),
        `${c.turns} turns`,
        `${c.model ? `${c.model} ` : ""}↑${tokens(c.usage.input)} ↓${tokens(c.usage.output)}`,
        cost(c.usage.cost),
      ]
        .filter(Boolean)
        .join(" · ");
      let text = `${theme.fg(color, "spawn")} ${c.emoji ? `${c.emoji} ` : ""}${theme.bold(c.id)} ${theme.fg("dim", stats)}`;
      if (c.error) text += `\n${theme.fg("error", c.error)}`;
      text += expanded
        ? `\n${c.summary || "(no summary)"}`
        : `\n${theme.fg("dim", oneLine(c.summary || "(no summary)", 120))}`;
      if (expanded && c.transcript)
        text += `\n${theme.fg("dim", `transcript: ${c.transcript}`)}`;
      const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(text, 0, 0));
      return box;
    },
  );
}
