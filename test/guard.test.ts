import assert from "node:assert/strict";
import { test } from "node:test";
import { PURE_SLEEP } from "../src/guard.ts";

test("PURE_SLEEP matches only commands that just sleep", () => {
  for (const cmd of ["sleep 20", "  sleep 1.5 ", "sleep 1m", "sleep 30;"])
    assert.ok(PURE_SLEEP.test(cmd), cmd);
  for (const cmd of [
    "sleep 2 && curl localhost:3000",
    "sleep 5; cat out.log",
    "npm run dev & sleep 3",
    "echo sleep 20",
    "sleep",
  ])
    assert.ok(!PURE_SLEEP.test(cmd), cmd);
});
