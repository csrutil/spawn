import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Agent,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { SubagentToolName } from "./config.ts";
import type { RunResult, Usage } from "./ring.ts";
import type { Transcript } from "./transcript.ts";

const TOOL_FACTORIES = {
  read: createReadTool,
  bash: createBashTool,
  edit: createEditTool,
  write: createWriteTool,
  grep: createGrepTool,
  find: createFindTool,
  ls: createLsTool,
} satisfies Record<SubagentToolName, (cwd: string) => unknown>;

export interface WorkerOptions {
  cwd: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: SubagentToolName[];
  modelRegistry: ModelRegistry;
  /** Approximate token cap for the summary. */
  summaryTokens: number;
  /** Receives every message as it ends. */
  transcript?: Transcript;
  /**
   * Called before edit/write with the absolute path. Returns the id of
   * another subagent that already changed the file, else claims it.
   */
  claim?: (path: string) => string | undefined;
}

export interface Progress {
  turns: number;
  toolUses: number;
  /** Tokens in the context window as of the last assistant message. */
  contextTokens: number;
  /** Short description of the current step. */
  activity: string;
}

function describeTool(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const arg = a.command ?? a.path ?? a.pattern ?? "";
  const flat = String(arg).replace(/\s+/g, " ").trim();
  return flat ? `${name} ${flat}` : name;
}

function systemPrompt(cwd: string, tools: SubagentToolName[]): string {
  return [
    "You are a subagent spawned by a main pi agent. You run in the background.",
    "Complete the task on your own. You cannot ask questions; make reasonable assumptions and state them.",
    "Other subagents may run at the same time. If a file edit fails because another subagent owns the file, do not work around it; report it.",
    `Working directory: ${cwd}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Tools: ${tools.join(", ") || "none"}`,
    "",
    "Your final message is the only thing the main agent sees. Make it a concise summary:",
    "- outcome (done / partial / failed)",
    "- key findings or changes, with file paths",
    "- open issues or next steps",
    "Do not repeat raw tool output in the final message.",
    "The main agent may send follow-up messages. Answer each with the same kind of summary.",
  ].join("\n");
}

/** Rough estimate, same heuristic as pi compaction. */
const CHARS_PER_TOKEN = 4;

function truncate(text: string, tokens: number): string {
  const max = tokens * CHARS_PER_TOKEN;
  if (text.length <= max) return text;
  const omitted = Math.ceil((text.length - max) / CHARS_PER_TOKEN);
  return `${text.slice(0, max)}\n[summary truncated: ~${omitted} tokens omitted]`;
}

/** Wraps edit/write so two subagents never change the same file. */
function guardWrites(
  tool: AgentTool,
  cwd: string,
  claim: (path: string) => string | undefined,
): AgentTool {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) => {
      const raw = String((params as { path?: unknown }).path ?? "");
      const path = resolve(cwd, raw.replace(/^~(?=$|\/)/, homedir()));
      const owner = claim(path);
      if (owner)
        throw new Error(
          `${raw} is being changed by subagent "${owner}". Leave it alone and mention the conflict in your summary.`,
        );
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

/**
 * A subagent: a plain pi Agent that keeps its conversation between runs, so
 * the main agent can send follow-ups after it finishes.
 */
export class Subagent {
  private readonly agent: Agent;
  private readonly summaryTokens: number;
  private progress: Progress = {
    turns: 0,
    toolUses: 0,
    contextTokens: 0,
    activity: "starting",
  };
  /** Called on turn, tool, and message changes of the current run. */
  onProgress?: (progress: Progress) => void;

  constructor(options: WorkerOptions) {
    const { model, modelRegistry, cwd, tools, claim, transcript } = options;
    this.summaryTokens = options.summaryTokens;
    this.agent = new Agent({
      initialState: {
        systemPrompt: systemPrompt(cwd, tools),
        model,
        thinkingLevel: options.thinkingLevel,
        tools: tools.map((name) => {
          const tool = TOOL_FACTORIES[name](cwd) as AgentTool;
          return claim && (name === "edit" || name === "write")
            ? guardWrites(tool, cwd, claim)
            : tool;
        }),
      },
      streamFn: (m, context, streamOptions) =>
        modelRegistry.streamSimple(m, context, streamOptions),
    });

    this.agent.subscribe((event) => {
      const p = this.progress;
      if (event.type === "message_end") {
        transcript?.append({ type: "message", message: event.message });
        if (event.message.role !== "assistant") return;
        const u = event.message.usage;
        p.contextTokens = u.input + u.cacheRead + u.cacheWrite + u.output;
      } else if (event.type === "turn_start") {
        p.turns++;
        p.activity = "thinking";
      } else if (event.type === "tool_execution_start") {
        p.toolUses++;
        p.activity = describeTool(event.toolName, event.args);
      } else if (event.type === "tool_execution_end") {
        p.activity = "thinking";
      } else return;
      this.onProgress?.({ ...p });
    });
  }

  /** Injects a message into the current run before its next model call. */
  steer(text: string): void {
    this.agent.steer({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
  }

  /** Runs one prompt to completion. Later calls continue the conversation. */
  async run(text: string, signal: AbortSignal): Promise<RunResult> {
    const { agent } = this;
    this.progress = {
      ...this.progress,
      turns: 0,
      toolUses: 0,
      activity: "starting",
    };
    const from = agent.state.messages.length;

    const onAbort = () => agent.abort();
    if (signal.aborted) throw new Error("aborted before start");
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await agent.prompt(text);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }

    const assistants = agent.state.messages
      .slice(from)
      .filter((m): m is AssistantMessage => m.role === "assistant");
    const usage: Usage = { input: 0, output: 0, cost: 0 };
    for (const m of assistants) {
      usage.input += m.usage.input;
      usage.output += m.usage.output;
      usage.cost += m.usage.cost.total;
    }
    const last = assistants.at(-1);
    const summary =
      last?.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim() ?? "";

    const failed =
      last?.stopReason === "error" || last?.stopReason === "aborted";
    return {
      summary: truncate(summary, this.summaryTokens),
      turns: assistants.length,
      usage,
      error: failed
        ? (last?.errorMessage ?? last?.stopReason)
        : (agent.state.errorMessage ?? (last ? undefined : "no response")),
    };
  }
}
