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

test("timeout is seconds; summaryTokens is validated", () => {
  const { config, warnings } = load({ timeout: 30, summaryTokens: 500 });
  assert.equal(config.timeout, 30);
  assert.equal(config.summaryTokens, 500);
  assert.deepEqual(warnings, []);
  const bad = load({ timeout: -1, summaryTokens: 0 });
  assert.equal(bad.config.timeout, 600);
  assert.equal(bad.config.summaryTokens, 1000);
  assert.equal(bad.warnings.length, 2);
});

test("SPAWN_MODEL overrides model, with or without spawn.json", () => {
  const path = join(mkdtempSync(join(tmpdir(), "spawn-")), "spawn.json");
  writeFileSync(path, JSON.stringify({ model: "a/b" }));
  assert.equal(
    loadConfig(path, { SPAWN_MODEL: "c/d:high" }).config.model,
    "c/d:high",
  );
  assert.equal(loadConfig(path, { SPAWN_MODEL: "  " }).config.model, "a/b");
  assert.equal(loadConfig(path, {}).config.model, "a/b");
  assert.equal(
    loadConfig("/nonexistent/spawn.json", { SPAWN_MODEL: "x" }).config.model,
    "x",
  );
});
