import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MAX_IN_FLIGHT = 64;

export const TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
export type SubagentToolName = (typeof TOOL_NAMES)[number];

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface SpawnConfig {
  /** Max subagents in flight. Capped at 64. */
  maxInFlight: number;
  /** "provider/id" or "id", optional ":level". null uses the main model. */
  model: string | null;
  /** null uses the main session's current thinking level. */
  thinkingLevel: ThinkingLevel | null;
  /** Upper bound for subagent tools. null in spawn.json means all. */
  tools: SubagentToolName[];
  deliverAs: "followUp" | "steer";
  /** Summary text sent to main is cut at this length. */
  maxSummaryChars: number;
  /** 0 disables the timeout. */
  timeoutMs: number;
}

export const DEFAULT_CONFIG: SpawnConfig = {
  maxInFlight: MAX_IN_FLIGHT,
  model: null,
  thinkingLevel: null,
  tools: [...TOOL_NAMES],
  deliverAs: "followUp",
  maxSummaryChars: 4000,
  timeoutMs: 600_000,
};

export function configPath(): string {
  return join(getAgentDir(), "spawn.json");
}

/** Loads spawn.json. Returns defaults plus warnings for invalid fields. */
export function loadConfig(path = configPath()): {
  config: SpawnConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const config: SpawnConfig = { ...DEFAULT_CONFIG, tools: [...TOOL_NAMES] };
  if (!existsSync(path)) return { config, warnings };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    warnings.push(`${path}: ${err instanceof Error ? err.message : err}`);
    return { config, warnings };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`${path}: expected a JSON object`);
    return { config, warnings };
  }
  const r = raw as Record<string, unknown>;
  const bad = (key: string) => warnings.push(`${path}: invalid "${key}"`);

  if (r.maxInFlight !== undefined) {
    if (
      typeof r.maxInFlight === "number" &&
      Number.isInteger(r.maxInFlight) &&
      r.maxInFlight >= 1
    ) {
      config.maxInFlight = Math.min(r.maxInFlight, MAX_IN_FLIGHT);
    } else bad("maxInFlight");
  }
  if (r.model !== undefined) {
    if (
      r.model === null ||
      (typeof r.model === "string" && r.model.trim() !== "")
    )
      config.model = r.model;
    else bad("model");
  }
  if (r.thinkingLevel !== undefined) {
    if (
      r.thinkingLevel === null ||
      THINKING_LEVELS.includes(r.thinkingLevel as ThinkingLevel)
    )
      config.thinkingLevel = r.thinkingLevel as ThinkingLevel | null;
    else bad("thinkingLevel");
  }
  // null means all tools (the default).
  if (r.tools !== undefined && r.tools !== null) {
    if (
      Array.isArray(r.tools) &&
      r.tools.every((t) => TOOL_NAMES.includes(t as SubagentToolName))
    )
      config.tools = r.tools as SubagentToolName[];
    else bad("tools");
  }
  if (r.deliverAs !== undefined) {
    if (r.deliverAs === "followUp" || r.deliverAs === "steer")
      config.deliverAs = r.deliverAs;
    else bad("deliverAs");
  }
  if (r.maxSummaryChars !== undefined) {
    if (typeof r.maxSummaryChars === "number" && r.maxSummaryChars > 0)
      config.maxSummaryChars = Math.floor(r.maxSummaryChars);
    else bad("maxSummaryChars");
  }
  if (r.timeoutMs !== undefined) {
    if (typeof r.timeoutMs === "number" && r.timeoutMs >= 0)
      config.timeoutMs = Math.floor(r.timeoutMs);
    else bad("timeoutMs");
  }
  return { config, warnings };
}
