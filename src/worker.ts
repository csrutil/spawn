import { Agent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
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
  task: string;
  cwd: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: SubagentToolName[];
  modelRegistry: ModelRegistry;
  /** Approximate token cap for the summary. */
  summaryTokens: number;
  /** Called on turn and tool changes. */
  onProgress?: (progress: Progress) => void;
}

export interface Progress {
  turns: number;
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
    `Working directory: ${cwd}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Tools: ${tools.join(", ") || "none"}`,
    "",
    "Your final message is the only thing the main agent sees. Make it a concise summary:",
    "- outcome (done / partial / failed)",
    "- key findings or changes, with file paths",
    "- open issues or next steps",
    "Do not repeat raw tool output in the final message.",
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

export async function runSubagent(
  options: WorkerOptions,
  signal: AbortSignal,
): Promise<RunResult> {
  const { model, modelRegistry, cwd, tools } = options;
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(cwd, tools),
      model,
      thinkingLevel: options.thinkingLevel,
      tools: tools.map((name) => TOOL_FACTORIES[name](cwd)),
    },
    streamFn: (m, context, streamOptions) =>
      modelRegistry.streamSimple(m, context, streamOptions),
  });

  const progress: Progress = { turns: 0, activity: "starting" };
  const report = options.onProgress;
  if (report) {
    agent.subscribe((event) => {
      if (event.type === "turn_start") {
        progress.turns++;
        progress.activity = "thinking";
      } else if (event.type === "tool_execution_start") {
        progress.activity = describeTool(event.toolName, event.args);
      } else if (event.type === "tool_execution_end") {
        progress.activity = "thinking";
      } else return;
      report({ ...progress });
    });
  }

  const onAbort = () => agent.abort();
  if (signal.aborted) throw new Error("aborted before start");
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await agent.prompt(options.task);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  const assistants = agent.state.messages.filter(
    (m): m is AssistantMessage => m.role === "assistant",
  );
  const usage: Usage = { input: 0, output: 0, cost: 0 };
  for (const m of assistants) {
    usage.input += m.usage.input;
    usage.output += m.usage.output;
    usage.cost += m.usage.cost.total;
  }
  const last = assistants.at(-1);
  const text =
    last?.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim() ?? "";

  const failed = last?.stopReason === "error" || last?.stopReason === "aborted";
  return {
    summary: truncate(text, options.summaryTokens),
    turns: assistants.length,
    usage,
    error: failed
      ? (last?.errorMessage ?? last?.stopReason)
      : (agent.state.errorMessage ?? (last ? undefined : "no response")),
  };
}
