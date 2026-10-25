/**
 * Admission control for agent runs.
 *
 * Two independent limits, because they fail differently:
 * - `maxConcurrent` protects the machine and the provider from a burst (a group chat where
 *   five people type at once).
 * - `minIntervalMs` spaces starts out, which is what actually keeps you under a per-minute
 *   rate limit; concurrency alone cannot express "at most one start every N ms".
 */
export class Gate {
  private active = 0;
  private lastStart = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;

  constructor(maxConcurrent: number, minIntervalMs: number) {
    this.maxConcurrent = maxConcurrent;
    this.minIntervalMs = minIntervalMs;
  }

  /** Resolves with an idempotent release function. */
  async acquire(): Promise<() => void> {
    if (this.active >= Math.max(1, this.maxConcurrent)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;

    const gap = this.minIntervalMs - (Date.now() - this.lastStart);
    if (gap > 0) await new Promise<void>((resolve) => setTimeout(resolve, gap));
    this.lastStart = Date.now();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }

  get inFlight(): number {
    return this.active;
  }
}
