import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Completion } from "../src/ring.ts";
import { type Row, SpawnWidget } from "../src/widget.ts";

const theme = {
  fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[39m`,
  getFgAnsi: () => "\x1b[38;2;100;100;100m",
} as unknown as Theme;

function row(id: string, emoji: string, completion?: Completion): Row {
  return {
    id,
    emoji,
    model: "glm-5.3-flash:high",
    startedAt: Date.now() - 27_000,
    turns: 12,
    activity: "thinking",
    completion,
  };
}

test("widget aligns metadata for running and completed rows with different names", () => {
  const now = Date.now();
  const finished: Completion = {
    id: "verify-usb-screen-timeout",
    task: "test",
    startedAt: now - 51_000,
    endedAt: now,
    status: "ok",
    turns: 18,
    usage: { input: 126_300, output: 6_000, cost: 0 },
    summary: "done",
  };
  const rows = [
    row("verify-contact-sort", "🦊"),
    row("verify-contact-refresh", "🐙"),
    row("verify-usb-screen-timeout", "🦉", finished),
    row("verify-double-click-back", "🐝"),
  ];
  const lines = new SpawnWidget(() => rows, theme).render(160);
  const columns = lines.map((line) => {
    const plain = stripTerminalSequences(line);
    const match = /\b(?:27s|51s)\b/.exec(plain);
    assert.ok(match);
    return visibleWidth(plain.slice(0, match.index));
  });
  assert.equal(new Set(columns).size, 1);
  assert.ok(lines.every((line) => visibleWidth(line) <= 160));
});
