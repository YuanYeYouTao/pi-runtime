export type MaintenanceDeps = {
  /** Threads that have been quiet long enough to be worth extracting. */
  idleThreads: () => Array<{ thread: string; pending: number }>;
  distill: (thread: string) => Promise<void>;
  /** Mark expired short-state slots stale. Cheap, so it runs every tick. */
  prune: () => number;
  /** Threads currently executing a task; never distilled concurrently with a reply. */
  busy?: Set<string>;
  log?: (message: string) => void;
};

export type MaintenanceReport = {
  pruned: number;
  distilled: string[];
  skipped: { thread: string; reason: string }[];
  failed: { thread: string; error: string }[];
};

/**
 * One maintenance tick for a long-running server.
 *
 * The gap this closes: distillation normally fires after N turns, so a conversation of two or
 * three messages never reaches the threshold and its memory is never extracted — the user said
 * something worth remembering, and it was silently dropped.
 *
 * Guards that matter:
 * - never distil a thread that is mid-reply (`busy`), or the batch sees a half-written turn;
 * - one failure must not abort the tick, or a single bad thread blocks every other one.
 */
export async function runMaintenance(deps: MaintenanceDeps): Promise<MaintenanceReport> {
  const report: MaintenanceReport = { pruned: 0, distilled: [], skipped: [], failed: [] };

  try {
    report.pruned = deps.prune();
    if (report.pruned > 0) deps.log?.(`short state: ${report.pruned} slot(s) expired`);
  } catch (error) {
    deps.log?.(`prune failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const { thread, pending } of deps.idleThreads()) {
    if (deps.busy?.has(thread)) {
      report.skipped.push({ thread, reason: "busy" });
      continue;
    }
    deps.busy?.add(thread);
    try {
      await deps.distill(thread);
      report.distilled.push(thread);
      deps.log?.(`distilled ${thread} (${pending} events)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed.push({ thread, error: message });
      deps.log?.(`distil failed for ${thread}: ${message}`);
    } finally {
      deps.busy?.delete(thread);
    }
  }

  return report;
}
