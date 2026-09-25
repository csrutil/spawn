import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
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
  activity: string;
  completion?: Completion;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_ROWS = 8;

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
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
 * 100 ms. Blends RGB in truecolor themes; steps through theme colors otherwise.
 */
function shimmer(text: string, theme: Theme, now: number): string {
  const chars = [...text];
  const band = 3;
  const center = (Math.floor(now / 100) % (chars.length + band * 4)) - band * 2;
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

function renderRow(row: Row, theme: Theme, now: number): string {
  const c = row.completion;
  if (!c) {
    const name = `${row.emoji} ${shimmer(row.id, theme, now)}`;
    const frame = SPINNER[Math.floor(now / 100) % SPINNER.length];
    const meta = [
      seconds(now - row.startedAt),
      `turn ${row.turns}`,
      row.model,
      row.activity,
    ].join(" · ");
    return `${theme.fg("accent", frame)} ${name} ${theme.fg("dim", meta)}`;
  }
  const icon =
    c.status === "ok"
      ? theme.fg("success", "✓")
      : c.status === "error"
        ? theme.fg("error", "✗")
        : theme.fg("warning", "■");
  const name = `${row.emoji} ${theme.fg("muted", row.id)}`;
  const meta = [
    c.status === "ok" ? undefined : c.status,
    seconds(c.endedAt - c.startedAt),
    `${c.turns} turns`,
    `${row.model} ↑${tokens(c.usage.input)} ↓${tokens(c.usage.output)}`,
    c.error,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${icon} ${name} ${theme.fg("dim", meta)}`;
}

/** Live list of subagents shown above the editor. */
export class SpawnWidget implements Component {
  private readonly rows: () => Row[];
  private readonly theme: Theme;

  constructor(rows: () => Row[], theme: Theme) {
    this.rows = rows;
    this.theme = theme;
  }

  render(width: number): string[] {
    const rows = this.rows();
    const now = Date.now();
    const lines = rows
      .slice(-MAX_ROWS)
      .map((r) => truncateToWidth(renderRow(r, this.theme, now), width));
    if (rows.length > MAX_ROWS)
      lines.unshift(
        this.theme.fg("dim", `… ${rows.length - MAX_ROWS} more (/spawn)`),
      );
    return lines;
  }

  invalidate(): void {}
}
