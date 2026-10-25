import { backoffDelay, isRetryable, withRetry } from "../src/retry.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

// 1) classification: transient vs configuration errors
check("429 is retryable", isRetryable("HTTP 429 Too Many Requests"));
check("5xx is retryable", isRetryable("upstream returned 503"));
check("socket reset is retryable", isRetryable("read ECONNRESET"));
check("timeout is retryable", isRetryable("request timed out"));
check("missing key is NOT retryable", !isRetryable("No API key found for the selected model"));
check("unknown model is NOT retryable", !isRetryable("Model not found: foo/bar"));
check("budget is NOT retryable", !isRetryable("budget_exceeded: 今日已用"));
check("auth is NOT retryable", !isRetryable("401 Unauthorized"));

// 2) backoff: grows, capped, jittered within [half, full]
const policy = { attempts: 5, baseMs: 1000, maxMs: 8000 };
const d1 = backoffDelay(1, policy);
const d2 = backoffDelay(2, policy);
const d9 = backoffDelay(9, policy);
check("attempt 1 within [500,1000]", d1 >= 500 && d1 <= 1000, String(d1));
check("attempt 2 within [1000,2000]", d2 >= 1000 && d2 <= 2000, String(d2));
check("capped at maxMs", d9 <= 8000, String(d9));

// 3) retry succeeds after transient failures
{
  let calls = 0;
  const delays = [];
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("HTTP 500 upstream");
      return "ok";
    },
    { attempts: 3, baseMs: 10, maxMs: 20 },
    { sleep: async (ms) => delays.push(ms) },
  );
  check("retries until success", result === "ok" && calls === 3, `calls=${calls}`);
  check("sleeps between attempts only", delays.length === 2, String(delays.length));
}

// 4) non-retryable fails on the first attempt
{
  let calls = 0;
  let message = "";
  try {
    await withRetry(
      async () => {
        calls++;
        throw new Error("No API key found for the selected model");
      },
      { attempts: 5, baseMs: 10, maxMs: 20 },
      { sleep: async () => {} },
    );
  } catch (error) {
    message = error.message;
  }
  check("non-retryable fails fast", calls === 1, `calls=${calls}`);
  check("original error preserved", message.includes("No API key"), message);
}

// 5) exhausts attempts and surfaces the last error
{
  let calls = 0;
  try {
    await withRetry(
      async () => {
        calls++;
        throw new Error(`HTTP 502 attempt ${calls}`);
      },
      { attempts: 3, baseMs: 1, maxMs: 2 },
      { sleep: async () => {} },
    );
  } catch {
    /* expected */
  }
  check("gives up after max attempts", calls === 3, `calls=${calls}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
