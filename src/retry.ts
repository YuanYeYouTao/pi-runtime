export type RetryPolicy = {
  /** Total attempts, including the first one. */
  attempts: number;
  baseMs: number;
  maxMs: number;
};

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseMs: 2_000, maxMs: 30_000 };

/**
 * Errors worth retrying are the ones that pass on their own: rate limits, 5xx, transport
 * failures, timeouts. Everything else (bad model name, missing API key, malformed prompt)
 * is a configuration error and retrying only burns time and money.
 */
const RETRYABLE = [
  /\b429\b/,
  /rate.?limit/i,
  /too many requests/i,
  /\b5\d{2}\b/,
  /overloaded/i,
  /timeout/i,
  /timed out/i,
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE/i,
  /socket hang up/i,
  /fetch failed/i,
  /network/i,
  /temporarily unavailable/i,
  // The agent subprocess dying is usually transient (OOM, kill, provider hiccup).
  /pi exited|exited \(\d+\)|exited \(null\)/i,
];

const NON_RETRYABLE = [
  /no api key/i,
  /model not found/i,
  /invalid model/i,
  /unauthorized|\b401\b|\b403\b/i,
  /budget/i,
];

export function isRetryable(message: string): boolean {
  if (NON_RETRYABLE.some((pattern) => pattern.test(message))) return false;
  return RETRYABLE.some((pattern) => pattern.test(message));
}

/** Exponential backoff with full jitter, capped. Exported for tests. */
export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const exponential = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exponential / 2 + Math.random() * (exponential / 2);
  return Math.round(jitter);
}

/**
 * Run `fn` with retries. `fn` receives the attempt number (1-based) so callers can log it.
 * The delay is applied *between* attempts, never before the first one.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
  hooks: { onRetry?: (attempt: number, delayMs: number, error: Error) => void; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: Error = new Error("no attempt made");

  for (let attempt = 1; attempt <= Math.max(1, policy.attempts); attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const canRetry = attempt < policy.attempts && isRetryable(lastError.message);
      if (!canRetry) throw lastError;
      const delay = backoffDelay(attempt, policy);
      hooks.onRetry?.(attempt, delay, lastError);
      await sleep(delay);
    }
  }

  throw lastError;
}
