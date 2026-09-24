import assert from "node:assert/strict";
import { test } from "node:test";
import { type ModelLike, resolveModel } from "../src/model.ts";

const models: ModelLike[] = [
  { provider: "openai", id: "gpt-5.6-luna" },
  { provider: "droid-core", id: "gpt-5.6-luna" },
  { provider: "droid-core", id: "glm-5.3-flash" },
  { provider: "deepinfra", id: "zai-org/GLM-5.3-Flash" },
  { provider: "bedrock", id: "claude-x-v1:0" },
];
const authed = new Set(["openai"]);
const opts = { hasAuth: (m: ModelLike) => authed.has(m.provider) };

function pick(spec: string, preferProvider?: string) {
  const r = resolveModel(spec, models, { ...opts, preferProvider });
  return r.ok ? `${r.model.provider}/${r.model.id}|${r.level ?? ""}` : r.error;
}

test("provider/id, including ids with slashes", () => {
  assert.equal(pick("droid-core/glm-5.3-flash"), "droid-core/glm-5.3-flash|");
  assert.equal(
    pick("deepinfra/zai-org/GLM-5.3-Flash"),
    "deepinfra/zai-org/GLM-5.3-Flash|",
  );
});

test("bare id prefers main provider, then auth", () => {
  assert.equal(pick("gpt-5.6-luna"), "openai/gpt-5.6-luna|");
  assert.equal(pick("gpt-5.6-luna", "droid-core"), "droid-core/gpt-5.6-luna|");
  assert.equal(
    pick("zai-org/glm-5.3-flash"),
    "deepinfra/zai-org/GLM-5.3-Flash|",
  );
});

test(":level suffix sets thinking level; non-level colons stay in id", () => {
  assert.equal(pick("gpt-5.6-luna:high"), "openai/gpt-5.6-luna|high");
  assert.equal(
    pick("droid-core/glm-5.3-flash:max"),
    "droid-core/glm-5.3-flash|max",
  );
  assert.equal(pick("claude-x-v1:0"), "bedrock/claude-x-v1:0|");
});

test("unknown model lists close matches", () => {
  const err = pick("gpt-5.6");
  assert.match(err, /unknown model "gpt-5.6"/);
  assert.match(err, /openai\/gpt-5.6-luna/);
});
