import { runMaintenance } from "../src/maintenance.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

// 1) idle threads are distilled, one call each
{
  const calls = [];
  const report = await runMaintenance({
    idleThreads: () => [{ thread: "a", pending: 3 }, { thread: "b", pending: 5 }],
    distill: async (thread) => {
      calls.push(thread);
    },
    prune: () => 0,
  });
  check("distils every idle thread", calls.join(",") === "a,b", calls.join(","));
  check("reports what it distilled", report.distilled.join(",") === "a,b");
  check("no failures", report.failed.length === 0);
}

// 2) a busy thread is skipped, not raced
{
  const busy = new Set(["a"]);
  const calls = [];
  const report = await runMaintenance({
    idleThreads: () => [{ thread: "a", pending: 2 }, { thread: "b", pending: 2 }],
    distill: async (thread) => {
      calls.push(thread);
    },
    prune: () => 0,
    busy,
  });
  check("busy thread is skipped", !calls.includes("a") && calls.includes("b"), calls.join(","));
  check("skip is reported", report.skipped.some((s) => s.thread === "a" && s.reason === "busy"));
  // `a` was locked by someone else; maintenance must not release a lock it did not take.
  check("foreign lock is left alone", busy.has("a"), JSON.stringify([...busy]));
  check("own lock is released", !busy.has("b"), JSON.stringify([...busy]));
}

// 3) one failing thread does not stop the others
{
  const calls = [];
  const report = await runMaintenance({
    idleThreads: () => [{ thread: "bad", pending: 1 }, { thread: "good", pending: 1 }],
    distill: async (thread) => {
      calls.push(thread);
      if (thread === "bad") throw new Error("model exploded");
    },
    prune: () => 0,
  });
  check("continues after a failure", calls.join(",") === "bad,good", calls.join(","));
  check("failure is recorded", report.failed.length === 1 && report.failed[0].thread === "bad", JSON.stringify(report.failed));
  check("success is still reported", report.distilled.join(",") === "good");
  check("error message survives", report.failed[0].error === "model exploded");
}

// 4) prune runs even when there is nothing to distil
{
  let pruned = 0;
  const report = await runMaintenance({
    idleThreads: () => [],
    distill: async () => {},
    prune: () => {
      pruned++;
      return 2;
    },
  });
  check("prune always runs", pruned === 1);
  check("prune count is reported", report.pruned === 2);
}

// 5) a broken prune does not prevent distillation
{
  const calls = [];
  const report = await runMaintenance({
    idleThreads: () => [{ thread: "a", pending: 1 }],
    distill: async (thread) => {
      calls.push(thread);
    },
    prune: () => {
      throw new Error("disk on fire");
    },
  });
  check("prune failure is survivable", calls.join(",") === "a");
  check("prune failure is not fatal", report.pruned === 0);
}

// 6) logging is optional and never throws
{
  let logged = 0;
  await runMaintenance({
    idleThreads: () => [{ thread: "a", pending: 1 }],
    distill: async () => {},
    prune: () => 1,
    log: () => {
      logged++;
    },
  });
  check("logs prune and distil", logged >= 2, String(logged));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
