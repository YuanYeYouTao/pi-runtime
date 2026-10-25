import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export type Sample = { chars: number; tokens: number; taskId?: string };

export type Fit = {
  /** Tokens per character of *our* composed prompt. */
  slope: number;
  /** Fixed overhead the provider counts that we never see (system prompt, tool schemas). */
  intercept: number;
  r2: number;
  samples: number;
};

const DEFAULT_CHARS_PER_TOKEN = 3.5;
/** Below this, a fit is noise. Four points can fit anything. */
export const MIN_SAMPLES = 8;

/**
 * Least squares fit of `tokens = slope * chars + intercept`.
 *
 * The intercept matters: pi sends its own system prompt and tool definitions, so provider
 * input tokens exceed our prompt. Dividing tokens by characters (no intercept) inflates the
 * ratio and makes every estimate look worse than it is.
 */
export function fitLinear(samples: Sample[]): Fit | null {
  const points = samples.filter((sample) => sample.chars > 0 && sample.tokens > 0);
  if (points.length < MIN_SAMPLES) return null;

  const n = points.length;
  const meanX = points.reduce((sum, p) => sum + p.chars, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.tokens, 0) / n;

  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    sxx += (point.chars - meanX) ** 2;
    sxy += (point.chars - meanX) * (point.tokens - meanY);
  }
  // No spread in prompt sizes: a slope cannot be identified.
  if (sxx < 1) return null;

  const slope = sxy / sxx;
  if (!Number.isFinite(slope) || slope <= 0) return null;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (const point of points) {
    const predicted = slope * point.chars + intercept;
    ssRes += (point.tokens - predicted) ** 2;
    ssTot += (point.tokens - meanY) ** 2;
  }
  const r2 = ssTot < 1e-9 ? 0 : Math.max(0, 1 - ssRes / ssTot);

  return { slope, intercept, r2, samples: n };
}

/** Converts a fit into the `charsPerToken` that `compose()` expects. */
export function charsPerTokenFrom(fit: Fit | null): number {
  if (!fit || fit.slope <= 0) return DEFAULT_CHARS_PER_TOKEN;
  return Math.round((1 / fit.slope) * 100) / 100;
}

export class CalibrationStore {
  private readonly db: DatabaseSync;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.db = new DatabaseSync(path.join(dataDir, "runtime.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calibration_samples (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT,
        chars      INTEGER NOT NULL,
        tokens     INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  record(sample: Sample, keep = 200): void {
    if (!(sample.chars > 0) || !(sample.tokens > 0)) return;
    this.db
      .prepare("INSERT INTO calibration_samples (task_id, chars, tokens, created_at) VALUES (?, ?, ?, ?)")
      .run(sample.taskId ?? null, Math.round(sample.chars), Math.round(sample.tokens), new Date().toISOString());
    // Bound the history: calibration only needs recent behaviour.
    this.db
      .prepare("DELETE FROM calibration_samples WHERE id NOT IN (SELECT id FROM calibration_samples ORDER BY id DESC LIMIT ?)")
      .run(keep);
  }

  samples(limit = 200): Sample[] {
    return this.db
      .prepare("SELECT task_id AS taskId, chars, tokens FROM calibration_samples ORDER BY id DESC LIMIT ?")
      .all(limit) as Sample[];
  }

  fit(): Fit | null {
    return fitLinear(this.samples());
  }

  charsPerToken(): number {
    return charsPerTokenFrom(this.fit());
  }

  /**
   * Recover samples from history: `usage.input` joined with the `context_plan` that produced
   * it. Idempotent — existing task ids are skipped.
   */
  backfill(): number {
    const rows = this.db
      .prepare(
        `SELECT u.task_id AS taskId, u.input AS tokens, e.payload AS plan
           FROM usage u
           JOIN events e ON e.task_id = u.task_id AND e.type = 'context_plan'
          WHERE u.input > 0`,
      )
      .all() as Array<{ taskId: string; tokens: number; plan: string }>;

    const existing = new Set(
      (this.db.prepare("SELECT task_id FROM calibration_samples WHERE task_id IS NOT NULL").all() as Array<{ task_id: string }>).map(
        (row) => row.task_id,
      ),
    );

    let added = 0;
    for (const row of rows) {
      if (existing.has(row.taskId)) continue;
      let chars = 0;
      try {
        chars = Number(JSON.parse(row.plan).usedChars ?? 0);
      } catch {
        continue;
      }
      if (chars <= 0) continue;
      this.record({ chars, tokens: row.tokens, taskId: row.taskId });
      added++;
    }
    return added;
  }

  reset(): number {
    const result = this.db.prepare("DELETE FROM calibration_samples").run();
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}

export { DEFAULT_CHARS_PER_TOKEN };
