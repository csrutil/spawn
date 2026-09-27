import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type Row, SpawnWidget } from "../src/widget.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getFgAnsi: () => "",
} as unknown as Theme;

const NOW = 1_000_000;
const usage = { input: 2600, output: 147, cost: 0.0012 };

function row(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    emoji: "🦊",
    model: "m:high",
    startedAt: NOW - 12_300,
    turns: 5,
    toolUses: 5,
    contextTokens: 33_800,
    contextWindow: 200_000,
    activity: "bash ls",
    ...extra,
  };
}

test("renders running and finished agents as a tree", () => {
  const rows = [
    row("a", {
      completion: {
        id: "a",
        task: "",
        status: "error",
        error: "429",
        summary: "",
        turns: 2,
        toolUses: 1,
        usage,
        startedAt: NOW - 3000,
        endedAt: NOW,
      } as Row["completion"],
      toolUses: 1,
    }),
    row("b"),
  ];
  const lines = new SpawnWidget(
    () => rows,
    () => 0,
    theme,
  ).render(200, NOW);
  assert.deepEqual(lines, [
    "● Spawn Agents 1 running · 1 failed",
    "├─ ✗ 🦊 a · error · 2 turns · 1 tool use · ↑2.6k ↓147 · $0.0012 · 3s · m:high",
    "│   ⎿  429",
    "└─ ⠦ 🦊 b · 5 turns · 5 tool uses · 33.8k token (17%) · 12s · m:high",
    "    ⎿  bash ls",
  ]);
});

test("queued and hidden rows close the tree", () => {
  const rows = Array.from({ length: 9 }, (_, i) => row(`r${i}`));
  const lines = new SpawnWidget(
    () => rows,
    () => 2,
    theme,
  ).render(200, NOW);
  assert.equal(lines[0], "● Spawn Agents 9 running · 2 queued");
  assert.deepEqual(lines.slice(-2), ["├─ 1 earlier (/spawn)", "└─ 2 queued"]);
  assert.ok(lines.at(-3)?.startsWith("│   ⎿  "));
});

test("metadata starts in one column across names of different length", () => {
  const rows = [
    row("verify-contact-sort"),
    row("verify-usb-screen-timeout", {
      completion: {
        id: "verify-usb-screen-timeout",
        task: "",
        status: "ok",
        summary: "",
        turns: 18,
        usage,
        startedAt: NOW - 51_000,
        endedAt: NOW,
      },
    }),
    row("x"),
  ];
  const lines = new SpawnWidget(
    () => rows,
    () => 0,
    theme,
  ).render(200, NOW);
  const heads = lines.filter((l) => /^[├└]─ /.test(l));
  const columns = heads.map((l) => visibleWidth(l.slice(0, l.indexOf("· "))));
  assert.equal(heads.length, 3);
  assert.equal(new Set(columns).size, 1);
});
