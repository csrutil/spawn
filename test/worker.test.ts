import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Transcript } from "../src/transcript.ts";
import { Subagent, type WorkerOptions } from "../src/worker.ts";

function setup() {
  const faux = createFauxCore({});
  const cwd = mkdtempSync(join(tmpdir(), "spawn-w-"));
  writeFileSync(join(cwd, "a.txt"), "one\n");
  const claims = new Map<string, string>();
  const make = (id: string, transcript?: Transcript) =>
    new Subagent({
      cwd,
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: ["read", "edit"],
      modelRegistry: {
        streamSimple: faux.streamSimple,
      } as unknown as ModelRegistry,
      summaryTokens: 1000,
      transcript,
      claim: (path) => {
        const owner = claims.get(path);
        if (owner && owner !== id) return owner;
        claims.set(path, id);
        return undefined;
      },
    } as WorkerOptions);
  return { faux, cwd, make };
}

const edit = (text: string) =>
  fauxAssistantMessage([
    fauxToolCall(
      "edit",
      { path: "a.txt", edits: [{ oldText: "one", newText: text }] },
      { id: `e-${text}` },
    ),
  ]);

test("a file changed by one subagent is locked for another", async () => {
  const { faux, cwd, make } = setup();
  const log = new Transcript(join(cwd, "log", "first.jsonl"));
  const first = make("first", log);
  const second = make("second");
  const signal = new AbortController().signal;

  faux.setResponses([edit("two"), fauxAssistantMessage([fauxText("done")])]);
  const r1 = await first.run("change it", signal);
  assert.equal(r1.summary, "done");
  assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "two\n");

  let toolError = "";
  faux.setResponses([
    edit("three"),
    (ctx) => {
      const last = ctx.messages.at(-1) as {
        content: { text: string }[];
      };
      toolError = last.content[0].text;
      return fauxAssistantMessage([fauxText("blocked")]);
    },
  ]);
  const r2 = await second.run("change it too", signal);
  assert.equal(r2.summary, "blocked");
  assert.match(toolError, /being changed by subagent "first"/);
  assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "two\n");

  // Follow-up keeps the earlier conversation.
  let seen = 0;
  faux.setResponses([
    (ctx) => {
      seen = ctx.messages.length;
      return fauxAssistantMessage([fauxText("again")]);
    },
  ]);
  const r3 = await first.run("anything else?", signal);
  assert.equal(r3.summary, "again");
  assert.equal(r3.turns, 1);
  assert.ok(seen >= 5, `expected earlier messages in context, got ${seen}`);

  const lines = readFileSync(log.path, "utf8").trim().split("\n");
  assert.ok(lines.length >= 6);
  assert.ok(lines.every((l) => JSON.parse(l).type === "message"));
});
