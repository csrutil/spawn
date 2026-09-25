/**
 * In-flight subagent registry with io_uring-style semantics.
 *
 * - submit(): starts a task at once and returns its id. No wait queue.
 *   When `limit` tasks are in flight, submit() fails with EAGAIN.
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
  | { ok: true; id: string }
  | { ok: false; error: "EAGAIN"; inFlight: number; limit: number };

interface InFlight extends TaskInfo {
  controller: AbortController;
  cancelled: boolean;
  timedOut: boolean;
}

const EMPTY_USAGE: Usage = { input: 0, output: 0, cost: 0 };

export interface RingOptions {
  limit: number;
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
  private readonly history: Completion[] = [];
  private readonly usedIds = new Set<string>();

  constructor(options: RingOptions) {
    this.options = options;
  }

  /** Starts a task named after `entry.name`, made unique with a -N suffix. */
  submit(entry: { name: string; task: string }, run: Runner): SubmitResult {
    if (this.inFlight.size >= this.options.limit) {
      return {
        ok: false,
        error: "EAGAIN",
        inFlight: this.inFlight.size,
        limit: this.options.limit,
      };
    }
    const base = slugName(entry.name, entry.task);
    let id = base;
    for (let n = 2; this.usedIds.has(id); n++) id = `${base}-${n}`;
    this.usedIds.add(id);
    const item: InFlight = {
      id,
      task: entry.task,
      startedAt: Date.now(),
      controller: new AbortController(),
      cancelled: false,
      timedOut: false,
    };
    this.inFlight.set(id, item);
    void this.execute(item, run);
    return { ok: true, id };
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
    return targets.length;
  }

  running(): TaskInfo[] {
    return [...this.inFlight.values()].map(({ id, task, startedAt }) => ({
      id,
      task,
      startedAt,
    }));
  }

  completed(): Completion[] {
    return [...this.history];
  }

  get size(): number {
    return this.inFlight.size;
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
    this.history.push(completion);
    if (this.history.length > this.options.historySize) this.history.shift();
    this.options.onComplete(completion);
  }
}
