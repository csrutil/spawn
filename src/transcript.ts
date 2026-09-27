/**
 * Per-subagent transcripts: one JSONL file per subagent id next to the main
 * session file, at `<session>/spawn/<id>.jsonl`. Lines are appended as the
 * subagent runs, so a running subagent can be inspected too.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type TranscriptEntry =
  | {
      type: "header";
      id: string;
      task: string;
      model: string;
      cwd: string;
      tools: string[];
      startedAt: number;
    }
  | { type: "message"; message: unknown }
  | { type: "completion"; [key: string]: unknown };

/** `<session file without .jsonl>/spawn`, or undefined for in-memory sessions. */
export function transcriptDir(sessionFile: string | undefined) {
  return sessionFile
    ? join(sessionFile.replace(/\.jsonl$/, ""), "spawn")
    : undefined;
}

/** Ids that already have a transcript in `dir`. */
export function transcriptIds(dir: string | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
}

export class Transcript {
  readonly path: string;
  private failed = false;

  constructor(path: string) {
    this.path = path;
  }

  /** Best effort: a write error disables the transcript, never the run. */
  append(entry: TranscriptEntry): void {
    if (this.failed) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    } catch {
      this.failed = true;
    }
  }
}

function flat(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

interface Part {
  type: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface Message {
  role?: string;
  content?: string | Part[];
  isError?: boolean;
  toolName?: string;
}

function texts(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join(" ");
}

/** One line per step: prompts, replies, tool calls, failed tool results. */
export function formatTranscript(jsonl: string, maxLines = 40): string[] {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: TranscriptEntry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "header") {
      out.push(`# ${e.id} · ${e.model} · ${e.cwd}`);
      continue;
    }
    if (e.type === "completion") {
      out.push(`= ${e.status}${e.error ? `: ${e.error}` : ""}`);
      continue;
    }
    const m = e.message as Message;
    if (m.role === "user") out.push(`› ${flat(texts(m.content), 160)}`);
    else if (m.role === "assistant") {
      const t = texts(m.content);
      if (t.trim()) out.push(`  ${flat(t, 160)}`);
      for (const p of Array.isArray(m.content) ? m.content : [])
        if (p.type === "toolCall")
          out.push(
            `  → ${p.name} ${flat(JSON.stringify(p.arguments ?? {}), 120)}`,
          );
    } else if (m.role === "toolResult" && m.isError)
      out.push(`  ✗ ${m.toolName}: ${flat(texts(m.content), 120)}`);
  }
  return out.length > maxLines
    ? [`… ${out.length - maxLines} earlier lines`, ...out.slice(-maxLines)]
    : out;
}

export function readTranscript(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
