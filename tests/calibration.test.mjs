import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fitLinear, charsPerTokenFrom, CalibrationStore, MIN_SAMPLES, DEFAULT_CHARS_PER_TOKEN } from "../src/calibration.ts";
import { Store } from "../src/db.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const point = (chars, tokens) => ({ chars, tokens });

// 1) too few samples cannot be fitted
{
  check("null below the minimum", fitLinear([point(100, 50), point(200, 90)]) === null);
  const nine = Array.from({ length: 9 }, (_, i) => point(100 + i * 10, 80 + i * 3));
  check("fits at the minimum", fitLinear(nine) !== null);
  check("minimum is 8", MIN_SAMPLES === 8);
}

// 2) exact linear data is recovered, intercept included
{
  const truth = { slope: 0.3, intercept: 500 };
  const samples = Array.from({ length: 10 }, (_, i) => {
    const chars = 400 + i * 120;
    return point(chars, truth.slope * chars + truth.intercept);
  });
  const fit = fitLinear(samples);
  check("recovers the slope", Math.abs(fit.slope - 0.3) < 1e-6, String(fit.slope));
  check("recovers the overhead", Math.abs(fit.intercept - 500) < 1e-6, String(fit.intercept));
  check("perfect fit has r2 1", Math.abs(fit.r2 - 1) < 1e-9, String(fit.r2));
  check("chars per token = 1/slope", charsPerTokenFrom(fit) === Number((1 / 0.3).toFixed(2)), String(charsPerTokenFrom(fit)));
}

// 3) no spread in prompt size means no identifiable slope
{
  const flat = Array.from({ length: 10 }, () => point(500, 300));
  check("rejects degenerate input", fitLinear(flat) === null);
}

// 4) noisy data fits approximately and reports quality
{
  const samples = [
    point(400, 700), point(520, 760), point(610, 900), point(700, 880),
    point(820, 1050), point(900, 1100), point(1000, 1180), point(1100, 1300),
    point(1200, 1350), point(1300, 1500),
  ];
  const fit = fitLinear(samples);
  check("fits noisy data", fit !== null && fit.slope > 0);
  check("r2 is between 0 and 1", fit.r2 >= 0 && fit.r2 <= 1, String(fit.r2));
  check("r2 is reported for trust", fit.r2 > 0.5, String(fit.r2));
}

// 5) fallback ratio when there is no usable fit
{
  check("falls back to 3.5", charsPerTokenFrom(null) === DEFAULT_CHARS_PER_TOKEN);
}

// 6) store: record, bound the history, and backfill from usage + context_plan
{
  const dir = path.join("eval", "tmp-calibration");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const store = new Store(path.join(dir, "runtime.db"));
  const calibration = new CalibrationStore(dir);

  // fabricate two historical runs: provider input = 0.3 * chars + 500
  for (const [taskId, chars] of [["t1", 400], ["t2", 900]]) {
    store.recordUsage(taskId, "m", { input: Math.round(0.3 * chars + 500), output: 10, total: 0, cost: 0 });
    store.appendEvent(taskId, "context_plan", { usedChars: chars });
  }
  check("backfills existing runs", calibration.backfill() === 2, String(calibration.backfill()));
  check("backfill is idempotent", calibration.backfill() === 0);
  check("backfilled samples are stored", calibration.samples().length === 2);

  calibration.record({ chars: 100, tokens: 530, taskId: "t3" });
  check("record appends", calibration.samples().length === 3);

  // still under the minimum: the ratio must stay at the default
  check("ratio stays default while under-sampled", calibration.charsPerToken() === DEFAULT_CHARS_PER_TOKEN);

  for (let i = 0; i < 8; i++) calibration.record({ chars: 500 + i * 100, tokens: 0.3 * (500 + i * 100) + 500, taskId: `x${i}` });
  check("ratio moves once the fit is usable", calibration.charsPerToken() !== DEFAULT_CHARS_PER_TOKEN, String(calibration.charsPerToken()));

  check("reset clears samples", calibration.reset() > 0 && calibration.samples().length === 0);

  calibration.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
