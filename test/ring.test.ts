import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Completion,
  Ring,
  type RunResult,
  slugName,
} from "../src/ring.ts";

const usage = { input: 1, output: 2, cost: 0 };

function makeRing(limit: number, timeout = 0, queueLimit = 0) {
  const done: Completion[] = [];
  const ring = new Ring({
    limit,
    queueLimit,
    timeout,
    historySize: 3,
    onComplete: (c) => done.push(c),
  });
  return { ring, done };
}

/** Runner that resolves when released, or rejects on abort. */
function controllable() {
  let release!: (r: RunResult) => void;
  const run = (signal: AbortSignal) =>
    new Promise<RunResult>((resolve, reject) => {
      release = resolve;
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  return { run, release: (r: RunResult) => release(r) };
}

const tick = () => new Promise((r) => setImmediate(r));

test("submit does not block and completion is delivered", async () => {
  const { ring, done } = makeRing(2);
  const c = controllable();
  const r = ring.submit({ name: "Count Lines", task: "t" }, c.run);
  assert.deepEqual(r, { ok: true, id: "count-lines", queued: false });
  assert.equal(ring.size, 1);
  assert.equal(done.length, 0);
  c.release({ summary: "sum", turns: 2, usage });
  await tick();
  assert.equal(ring.size, 0);
  assert.equal(done[0].status, "ok");
  assert.equal(done[0].summary, "sum");
});

test("EAGAIN when in-flight limit is reached, slot frees on completion", async () => {
  const { ring } = makeRing(2);
  const a = controllable();
  const b = controllable();
  ring.submit({ name: "a", task: "a" }, a.run);
  ring.submit({ name: "b", task: "b" }, b.run);
  const r = ring.submit({ name: "c", task: "c" }, controllable().run);
  assert.deepEqual(r, {
    ok: false,
    error: "EAGAIN",
    inFlight: 2,
    limit: 2,
    queued: 0,
  });
  a.release({ summary: "", turns: 1, usage });
  await tick();
  assert.equal(
    ring.submit({ name: "c", task: "c" }, controllable().run).ok,
    true,
  );
});

test("cancel one and all", async () => {
  const { ring, done } = makeRing(4);
  ring.submit({ name: "a", task: "a" }, controllable().run);
  ring.submit({ name: "b", task: "b" }, controllable().run);
  ring.submit({ name: "c", task: "c" }, controllable().run);
  assert.equal(ring.cancel("b"), 1);
  assert.equal(ring.cancel("nope"), 0);
  await tick();
  assert.equal(done[0].id, "b");
  assert.equal(done[0].status, "aborted");
  assert.equal(ring.cancel("all"), 2);
  await tick();
  assert.equal(ring.size, 0);
  assert.deepEqual(
    done.map((d) => d.status),
    ["aborted", "aborted", "aborted"],
  );
});

test("timeout aborts the task", async () => {
  const { ring, done } = makeRing(1, 0.01);
  ring.submit({ name: "slow", task: "slow" }, controllable().run);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done[0].status, "timeout");
});

test("runner error and result error map to error status", async () => {
  const { ring, done } = makeRing(2);
  ring.submit({ name: "x", task: "x" }, async () => {
    throw new Error("boom");
  });
  ring.submit({ name: "y", task: "y" }, async () => ({
    summary: "",
    turns: 1,
    usage,
    error: "429",
  }));
  await tick();
  assert.deepEqual(
    done.map((d) => [d.status, d.error]),
    [
      ["error", "boom"],
      ["error", "429"],
    ],
  );
});

test("history is bounded", async () => {
  const { ring } = makeRing(8);
  for (let i = 0; i < 5; i++)
    ring.submit({ name: `${i}`, task: `${i}` }, async () => ({
      summary: "",
      turns: 0,
      usage,
    }));
  await tick();
  assert.deepEqual(
    ring.completed().map((c) => c.id),
    ["2", "3", "4"],
  );
});

test("names are slugged, derived from task when empty, and unique", async () => {
  assert.equal(slugName("  Find Auth_Code! ", "x"), "find-auth-code");
  assert.equal(
    slugName("", "Count the lines in a.txt now"),
    "count-the-lines-in",
  );
  assert.equal(slugName("!!!", ""), "subagent");
  assert.ok(slugName("a".repeat(50), "").length <= 32);

  const { ring } = makeRing(8);
  const ids = [1, 2, 3].map((i) => {
    const r = ring.submit({ name: "scan", task: `${i}` }, async () => ({
      summary: "",
      turns: 0,
      usage,
    }));
    assert.ok(r.ok);
    return r.id;
  });
  assert.deepEqual(ids, ["scan", "scan-2", "scan-3"]);
  await tick();
  const again = ring.submit({ name: "scan", task: "4" }, controllable().run);
  assert.deepEqual(again, { ok: true, id: "scan-4", queued: false });
  ring.cancel("all");
});

test("queued tasks start in order as slots free", async () => {
  const { ring, done } = makeRing(1, 0, 2);
  const a = controllable();
  const b = controllable();
  const started: string[] = [];
  const track =
    (c: ReturnType<typeof controllable>) => (s: AbortSignal, id: string) => {
      started.push(id);
      return c.run(s);
    };
  ring.submit({ name: "a", task: "a" }, track(a));
  const rb = ring.submit({ name: "b", task: "b" }, track(b));
  const rc = ring.submit({ name: "c", task: "c" }, track(controllable()));
  assert.deepEqual(rb, { ok: true, id: "b", queued: true });
  assert.equal(rc.ok, true);
  assert.equal(ring.size, 3);
  assert.deepEqual(
    ring.queued().map((q) => q.id),
    ["b", "c"],
  );
  const full = ring.submit({ name: "d", task: "d" }, controllable().run);
  assert.equal(full.ok, false);
  assert.deepEqual(started, ["a"]);
  a.release({ summary: "", turns: 1, usage });
  await tick();
  assert.deepEqual(started, ["a", "b"]);
  assert.equal(done[0].id, "a");
  ring.cancel("all");
});

test("cancelling a queued task completes it as aborted without running", async () => {
  const { ring, done } = makeRing(1, 0, 4);
  let ran = false;
  ring.submit({ name: "a", task: "a" }, controllable().run);
  ring.submit({ name: "b", task: "b" }, async () => {
    ran = true;
    return { summary: "", turns: 0, usage };
  });
  assert.equal(ring.cancel("b"), 1);
  await tick();
  assert.equal(ran, false);
  assert.deepEqual(
    done.map((d) => [d.id, d.status]),
    [["b", "aborted"]],
  );
  ring.cancel("all");
});

test("resume reuses a finished id and rejects active or unknown ids", async () => {
  const { ring, done } = makeRing(2);
  const a = controllable();
  ring.submit({ name: "a", task: "t" }, a.run);
  assert.equal(ring.resume("a", "more", controllable().run), undefined);
  assert.equal(ring.resume("nope", "more", controllable().run), undefined);
  a.release({ summary: "", turns: 1, usage });
  await tick();
  const r = ring.resume("a", "more", async () => ({
    summary: "again",
    turns: 1,
    usage,
  }));
  assert.deepEqual(r, { ok: true, id: "a", queued: false });
  await tick();
  assert.deepEqual(
    done.map((d) => [d.id, d.summary]),
    [
      ["a", ""],
      ["a", "again"],
    ],
  );
});

test("reserved ids are not reused", () => {
  const ring = new Ring({
    limit: 2,
    queueLimit: 0,
    timeout: 0,
    historySize: 2,
    reserved: ["scan"],
    onComplete: () => {},
  });
  const r = ring.submit({ name: "scan", task: "x" }, controllable().run);
  assert.deepEqual(r, { ok: true, id: "scan-2", queued: false });
  ring.cancel("all");
});
