import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Store } from "../src/db.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const dir = path.join("eval", "tmp-usage");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const store = new Store(path.join(dir, "runtime.db"));

// 1) empty state
check("no usage initially", JSON.stringify(store.usageToday()) === JSON.stringify({ total: 0, cost: 0, runs: 0 }), JSON.stringify(store.usageToday()));

// 2) aggregation
store.recordUsage("t1", "deepseek-flash", { input: 100, output: 20, total: 120, cost: 0.001 });
store.recordUsage("t1", "deepseek-flash", { input: 50, output: 10, total: 60, cost: 0.0005 });
store.recordUsage("t2", "deepseek-flash", { input: 10, output: 5, total: 15, cost: 0.0001 });

const today = store.usageToday();
check("sums tokens across tasks", today.total === 195, String(today.total));
check("counts runs", today.runs === 3, String(today.runs));
check("sums cost", Math.abs(today.cost - 0.0016) < 1e-9, String(today.cost));

// 3) per-task view
const forTask = store.usageForTask("t1");
check("per-task total", forTask.total === 180, String(forTask.total));
check("unknown task is zero", store.usageForTask("nope").total === 0);

// 4) missing fields default to zero instead of NaN
store.recordUsage("t3", "m", {});
check("partial usage is safe", store.usageForTask("t3").total === 0 && Number.isFinite(store.usageForTask("t3").cost));

// 5) NaN inputs must not break the insert (SQLite binds NaN as NULL -> NOT NULL failure)
store.recordUsage("t4", "m", { total: Number.NaN, cost: Number.NaN, input: Number.NaN });
const t4 = store.usageForTask("t4");
check("NaN coercced to zero", t4.total === 0 && t4.cost === 0, JSON.stringify(t4));

store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
