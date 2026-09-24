import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, TOOL_NAMES } from "../src/config.ts";

function load(json: unknown) {
  const path = join(mkdtempSync(join(tmpdir(), "spawn-")), "spawn.json");
  writeFileSync(path, JSON.stringify(json));
  return loadConfig(path);
}

test("tools: null or omitted means all tools, no warning", () => {
  for (const cfg of [{ tools: null }, {}]) {
    const { config, warnings } = load(cfg);
    assert.deepEqual(config.tools, [...TOOL_NAMES]);
    assert.deepEqual(warnings, []);
  }
});

test("tools: subset is kept; unknown names warn and fall back to all", () => {
  assert.deepEqual(load({ tools: ["read", "grep"] }).config.tools, [
    "read",
    "grep",
  ]);
  const bad = load({ tools: ["read", "nope"] });
  assert.deepEqual(bad.config.tools, [...TOOL_NAMES]);
  assert.equal(bad.warnings.length, 1);
});

test("missing file gives defaults", () => {
  const { config, warnings } = loadConfig("/nonexistent/spawn.json");
  assert.equal(config.model, null);
  assert.equal(config.maxInFlight, 64);
  assert.deepEqual(warnings, []);
});
