/**
 * In-flight subagent registry with io_uring-style semantics.
 *
 * - submit(): starts a task at once and returns its id. When `limit` tasks
 *   are in flight, the task waits in a FIFO queue of up to `queueLimit`
 *   entries. Beyond that, submit() fails with EAGAIN.
 * - Each finished task produces one completion entry (CQE). It is passed to
 *   `onComplete` and kept in a bounded history for status queries.
 */

export type CompletionStatus = "ok" | "error" | "aborted" | "timeout";

export interface Usage {
  input: number;
  output: number;
  cost: number;
}

export interface RunResult {
  summary: string;
  turns: number;
  usage: Usage;
  /** Set when the run ended with a model or provider error. */
  error?: string;
}

export type Runner = (signal: AbortSignal, id: string) => Promise<RunResult>;

export interface TaskInfo {
  /** Unique kebab-case name. */
  id: string;
  task: string;
  startedAt: number;
}

export interface Completion extends TaskInfo {
  status: CompletionStatus;
  summary: string;
  error?: string;
  turns: number;
  usage: Usage;
  endedAt: number;
}

export type SubmitResult =
  | { ok: true; id: string; queued: boolean }
  | {
      ok: false;
      error: "EAGAIN";
      inFlight: number;
      limit: number;
      queued: number;
    };

interface InFlight extends TaskInfo {
  controller: AbortController;
  cancelled: boolean;
  timedOut: boolean;
}

interface Queued {
  id: string;
  task: string;
  run: Runner;
}

const EMPTY_USAGE: Usage = { input: 0, output: 0, cost: 0 };

export interface RingOptions {
  limit: number;
  /** Max tasks waiting for a slot. 0 disables the queue. */
  queueLimit: number;
  /** Ids already taken, e.g. by transcripts of an earlier run. */
  reserved?: Iterable<string>;
  /** Seconds. 0 disables the timeout. */
  timeout: number;
  historySize: number;
  onComplete: (completion: Completion) => void;
}

const MAX_NAME = 32;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME)
    .replace(/-+$/, "");
}

/** Kebab-case name from `name`, else from the first words of `task`. */
export function slugName(name: string, task: string): string {
  return (
    slugify(name) ||
    slugify(task.split(/\s+/).slice(0, 4).join(" ")) ||
    "subagent"
  );
}

export class Ring {
  private readonly options: RingOptions;
  private readonly inFlight = new Map<string, InFlight>();
  private readonly waiting: Queued[] = [];
  private readonly history: Completion[] = [];
  private readonly usedIds: Set<string>;

  constructor(options: RingOptions) {
    this.options = options;
    this.usedIds = new Set(options.reserved);
  }

  /** Starts a task named after `entry.name`, made unique with a -N suffix. */
  submit(entry: { name: string; task: string }, run: Runner): SubmitResult {
    const full = this.full();
    if (full) return full;
    const base = slugName(entry.name, entry.task);
    let id = base;
    for (let n = 2; this.usedIds.has(id); n++) id = `${base}-${n}`;
    this.usedIds.add(id);
    return this.enqueue({ id, task: entry.task, run });
  }

  /**
   * Starts another run under an existing id, e.g. a follow-up to a finished
   * subagent. Fails when the id is unknown or still active.
   */
  resume(id: string, task: string, run: Runner): SubmitResult | undefined {
    if (!this.usedIds.has(id) || this.isActive(id)) return undefined;
    return this.full() ?? this.enqueue({ id, task, run });
  }

  /** Abort one task or all tasks. Returns the number of tasks aborted. */
  cancel(id: string): number {
    const targets =
      id === "all"
        ? [...this.inFlight.values()]
        : [this.inFlight.get(id)].filter((t) => t !== undefined);
    for (const t of targets) {
      t.cancelled = true;
      t.controller.abort();
    }
    const dropped = this.waiting.filter((q) => id === "all" || q.id === id);
    for (const q of dropped) {
      this.waiting.splice(this.waiting.indexOf(q), 1);
      const now = Date.now();
      queueMicrotask(() =>
        this.finish({
          id: q.id,
          task: q.task,
          startedAt: now,
          endedAt: now,
          status: "aborted",
          summary: "",
          error: "cancelled while queued",
          turns: 0,
          usage: EMPTY_USAGE,
        }),
      );
    }
    return targets.length + dropped.length;
  }

  isActive(id: string): boolean {
    return this.inFlight.has(id) || this.waiting.some((q) => q.id === id);
  }

  running(): TaskInfo[] {
    return [...this.inFlight.values()].map(({ id, task, startedAt }) => ({
      id,
      task,
      startedAt,
    }));
  }

  queued(): Omit<TaskInfo, "startedAt">[] {
    return this.waiting.map(({ id, task }) => ({ id, task }));
  }

  completed(): Completion[] {
    return [...this.history];
  }

  /** Running plus queued tasks. */
  get size(): number {
    return this.inFlight.size + this.waiting.length;
  }

  private full(): SubmitResult | undefined {
    if (
      this.inFlight.size < this.options.limit ||
      this.waiting.length < this.options.queueLimit
    )
      return undefined;
    return {
      ok: false,
      error: "EAGAIN",
      inFlight: this.inFlight.size,
      limit: this.options.limit,
      queued: this.waiting.length,
    };
  }

  private enqueue(entry: Queued): SubmitResult {
    if (this.inFlight.size < this.options.limit) {
      this.start(entry);
      return { ok: true, id: entry.id, queued: false };
    }
    this.waiting.push(entry);
    return { ok: true, id: entry.id, queued: true };
  }

  private start({ id, task, run }: Queued): void {
    const item: InFlight = {
      id,
      task,
      startedAt: Date.now(),
      controller: new AbortController(),
      cancelled: false,
      timedOut: false,
    };
    this.inFlight.set(id, item);
    void this.execute(item, run);
  }

  private finish(completion: Completion): void {
    this.history.push(completion);
    if (this.history.length > this.options.historySize) this.history.shift();
    this.options.onComplete(completion);
  }

  private async execute(item: InFlight, run: Runner): Promise<void> {
    const timer =
      this.options.timeout > 0
        ? setTimeout(() => {
            item.timedOut = true;
            item.controller.abort();
          }, this.options.timeout * 1000)
        : undefined;

    let result: RunResult = { summary: "", turns: 0, usage: EMPTY_USAGE };
    let thrown: string | undefined;
    try {
      result = await run(item.controller.signal, item.id);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const status: CompletionStatus = item.timedOut
      ? "timeout"
      : item.cancelled
        ? "aborted"
        : thrown !== undefined || result.error !== undefined
          ? "error"
          : "ok";

    const completion: Completion = {
      id: item.id,
      task: item.task,
      startedAt: item.startedAt,
      endedAt: Date.now(),
      status,
      summary: result.summary,
      error: thrown ?? result.error,
      turns: result.turns,
      usage: result.usage,
    };

    this.inFlight.delete(item.id);
    const next = this.waiting.shift();
    if (next) this.start(next);
    this.finish(completion);
  }
}
