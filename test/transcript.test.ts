import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  formatTranscript,
  Transcript,
  transcriptDir,
  transcriptIds,
} from "../src/transcript.ts";

test("transcript dir sits next to the session file", () => {
  assert.equal(
    transcriptDir("/s/--proj--/2026_abc.jsonl"),
    "/s/--proj--/2026_abc/spawn",
  );
  assert.equal(transcriptDir(undefined), undefined);
});

test("append creates the dir, ids are listed, format condenses steps", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "spawn-")), "s", "spawn");
  const t = new Transcript(join(dir, "find-x.jsonl"));
  t.append({
    type: "header",
    id: "find-x",
    task: "t",
    model: "p/m:high",
    cwd: "/w",
    tools: ["read"],
    startedAt: 0,
  });
  t.append({
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "find x" }] },
  });
  t.append({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        { type: "toolCall", name: "grep", arguments: { pattern: "x" } },
      ],
    },
  });
  t.append({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "grep",
      isError: true,
      content: [{ type: "text", text: "boom" }],
    },
  });
  t.append({ type: "completion", status: "ok" });
  assert.deepEqual(transcriptIds(dir), ["find-x"]);
  assert.deepEqual(formatTranscript(readFileSync(t.path, "utf8")), [
    "# find-x · p/m:high · /w",
    "› find x",
    "  looking",
    '  → grep {"pattern":"x"}',
    "  ✗ grep: boom",
    "= ok",
  ]);
});
