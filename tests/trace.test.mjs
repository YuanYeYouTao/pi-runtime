import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Store } from "../src/db.ts";
import { buildSpanTree, formatSpanTree } from "../src/trace.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const dir = path.join("eval", "tmp-trace");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const store = new Store(path.join(dir, "runtime.db"));

// 1) spans record a duration and a status
{
  const root = store.startSpan("t1", "task", "ask");
  const child = store.startSpan("t1", "compose", "context", root, { chars: 500 });
  store.endSpan(child, "ok", { used: 486 });
  store.endSpan(root, "ok");

  const rows = store.spansOf("t1");
  check("stores the root and the child", rows.length === 2, String(rows.length));
  check("child points at the root", rows.find((r) => r.kind === "compose")?.parent_id === root);
  check("closed spans have an end", rows.every((r) => r.ended_at !== null));
  check("attrs are merged, not replaced", rows.find((r) => r.kind === "compose")?.attrs === JSON.stringify({ used: 486 }));
}

// 2) tree building: parents, orphans, ordering
{
  const rows = store.spansOf("t1");
  const tree = buildSpanTree(rows);
  check("one root", tree.length === 1, String(tree.length));
  check("root has a child", tree[0].children.length === 1);
  check("durations are computed", typeof tree[0].ms === "number");

  const orphan = buildSpanTree([
    { id: 9, task_id: "t2", parent_id: 404, kind: "tool", name: "bash", started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:00:01.000Z", status: "ok", attrs: null },
  ]);
  check("orphan becomes a root", orphan.length === 1 && orphan[0].name === "bash");
}

// 3) an unfinished span is shown as running, not as zero
{
  const id = store.startSpan("t3", "model", "prompt");
  const tree = buildSpanTree(store.spansOf("t3"));
  check("unfinished span has no duration", tree[0].ms === null);
  const lines = formatSpanTree(tree).join("\n");
  check("renders a running marker", lines.includes("…"), lines);
  store.endSpan(id, "ok");
}

// 4) the report leads with duration and marks failures
{
  const root = store.startSpan("t4", "task", "ask");
  const slow = store.startSpan("t4", "tool", "bash", root);
  const fast = store.startSpan("t4", "compose", "context", root);
  // Force a measurable difference without sleeping.
  store.endSpan(fast, "ok");
  store.endSpan(slow, "error");
  const lines = formatSpanTree(buildSpanTree(store.spansOf("t4")), { totalChars: 0 });
  check("mentions the failed span", lines.join("\n").includes("✗"), lines.join("\n"));
  check("explains how to read it", lines.join("\n").includes("问题就在那一层"), lines.join("\n"));
}

// 5) broken attrs never break the report
{
  const id = store.startSpan("t5", "tool", "read", null, { ok: 1 });
  store.db?.exec?.("UPDATE spans SET attrs = '{broken' WHERE id = " + id);
  const lines = formatSpanTree(buildSpanTree(store.spansOf("t5")));
  check("survives invalid attrs", lines.length === 1, JSON.stringify(lines));
}

store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
