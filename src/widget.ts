import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Completion } from "./ring.ts";

/** Per-subagent markers, assigned in spawn order. */
export const EMOJIS = [
  "🦊",
  "🐙",
  "🦉",
  "🐝",
  "🦄",
  "🐢",
  "🦀",
  "🐬",
  "🦁",
  "🐧",
  "🦋",
  "🐳",
  "🦔",
  "🐸",
  "🦜",
  "🐼",
];

export interface Row {
  id: string;
  emoji: string;
  /** "modelId:thinkingLevel" */
  model: string;
  startedAt: number;
  turns: number;
  toolUses: number;
  /** Tokens in the subagent's context as of its last response. */
  contextTokens: number;
  /** 0 when unknown. */
  contextWindow: number;
  activity: string;
  completion?: Completion;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Animation step. The widget re-renders at this interval while agents run. */
export const FRAME_MS = 150;
const MAX_ROWS = 8;

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export function cost(usd: number): string | undefined {
  if (usd <= 0) return undefined;
  return `$${usd.toFixed(usd < 0.1 ? 4 : 2)}`;
}

export function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function rgb(ansi: string): [number, number, number] | undefined {
  const m = /38;2;(\d+);(\d+);(\d+)/.exec(ansi);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/**
 * Shimmer: a bright band sweeps left to right over muted text, one step per
 * frame. Blends RGB in truecolor themes; steps through theme colors otherwise.
 */
function shimmer(text: string, theme: Theme, now: number): string {
  const chars = [...text];
  const band = 3;
  const center =
    (Math.floor(now / FRAME_MS) % (chars.length + band * 4)) - band * 2;
  const base = rgb(theme.getFgAnsi("muted"));
  const peak = rgb(theme.getFgAnsi("text"));
  return chars
    .map((ch, i) => {
      const d = Math.abs(i - center);
      if (d > band) return theme.fg("muted", ch);
      if (!base || !peak) return theme.fg(d === 0 ? "text" : "accent", ch);
      const t = (1 + Math.cos((Math.PI * d) / band)) / 2;
      const [r, g, b] = base.map((v, k) => Math.round(v + (peak[k] - v) * t));
      return `\x1b[38;2;${r};${g};${b}m${ch}\x1b[39m`;
    })
    .join("");
}

function turns(n: number): string {
  return `${n} ${n === 1 ? "turn" : "turns"}`;
}

function toolUses(n: number): string {
  return `${n} tool ${n === 1 ? "use" : "uses"}`;
}

function context(row: Row): string {
  const pct =
    row.contextWindow > 0
      ? ` (${Math.round((row.contextTokens / row.contextWindow) * 100)}%)`
      : "";
  return `${tokens(row.contextTokens)} token${pct}`;
}

function label(row: Row): string {
  return `${row.emoji} ${row.id}`;
}

/** Head line and optional detail line for one subagent. */
function renderRow(
  row: Row,
  theme: Theme,
  now: number,
  nameWidth: number,
): [head: string, detail?: string] {
  // Pads names so metadata starts in one column across rows.
  const pad = " ".repeat(nameWidth - visibleWidth(label(row)) + 1);
  const c = row.completion;
  if (!c) {
    const frame = SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length];
    const meta = [
      turns(row.turns),
      toolUses(row.toolUses),
      context(row),
      seconds(now - row.startedAt),
      row.model,
    ].join(" · ");
    return [
      `${theme.fg("accent", frame)} ${row.emoji} ${shimmer(row.id, theme, now)}${pad}${theme.fg("dim", `· ${meta}`)}`,
      theme.fg("dim", row.activity),
    ];
  }
  const icon =
    c.status === "ok"
      ? theme.fg("success", "✓")
      : c.status === "error"
        ? theme.fg("error", "✗")
        : theme.fg("warning", "■");
  const meta = [
    c.status === "ok" ? undefined : c.status,
    turns(c.turns),
    toolUses(row.toolUses),
    `↑${tokens(c.usage.input)} ↓${tokens(c.usage.output)}`,
    cost(c.usage.cost),
    seconds(c.endedAt - c.startedAt),
    row.model,
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    `${icon} ${row.emoji} ${theme.fg("muted", row.id)}${pad}${theme.fg("dim", `· ${meta}`)}`,
    c.error ? theme.fg("error", c.error) : undefined,
  ];
}

/** Live tree of subagents shown above the editor. */
export class SpawnWidget implements Component {
  private readonly rows: () => Row[];
  private readonly theme: Theme;

  constructor(rows: () => Row[], theme: Theme) {
    this.rows = rows;
    this.theme = theme;
  }

  render(width: number, now = Date.now()): string[] {
    const theme = this.theme;
    const rows = this.rows();
    const shown = rows.slice(-MAX_ROWS);
    const hidden = rows.length - shown.length;
    const running = rows.filter((r) => !r.completion).length;
    const failed = rows.filter(
      (r) => r.completion && r.completion.status !== "ok",
    ).length;
    const done = rows.length - running - failed;
    const counts = [
      `${running} running`,
      done > 0 ? `${done} done` : undefined,
      failed > 0 ? `${failed} failed` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    const dot = theme.fg(running > 0 ? "accent" : "dim", "●");
    const lines = [
      `${dot} ${theme.bold("Spawn Agents")} ${theme.fg("dim", counts)}`,
    ];
    const tail = [hidden > 0 ? `${hidden} earlier (/spawn)` : undefined].filter(
      (t) => t !== undefined,
    );
    const nameWidth = Math.max(0, ...shown.map((r) => visibleWidth(label(r))));
    shown.forEach((row, i) => {
      const last = i === shown.length - 1 && tail.length === 0;
      const branch = theme.fg("dim", last ? "└─ " : "├─ ");
      const stem = theme.fg("dim", last ? "   " : "│  ");
      const [head, detail] = renderRow(row, theme, now, nameWidth);
      lines.push(branch + head);
      if (detail) lines.push(`${stem}${theme.fg("dim", " ⎿  ")}${detail}`);
    });
    tail.forEach((t, i) => {
      const branch = i === tail.length - 1 ? "└─" : "├─";
      lines.push(theme.fg("dim", `${branch} ${t}`));
    });
    return lines.map((l) => truncateToWidth(l, width));
  }

  invalidate(): void {}
}
