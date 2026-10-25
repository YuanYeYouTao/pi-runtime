import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Store } from "../src/db.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const dir = path.join("eval", "tmp-thread-state");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const store = new Store(path.join(dir, "runtime.db"));

// Seed five events in one thread.
const ids = [];
for (let i = 0; i < 5; i++) {
  ids.push(store.addConversationEvent("t1", "Rick", i % 2 === 0 ? "user" : "assistant", `m${i + 1}`));
}

// 1) thread state round-trip
check("empty state by default", JSON.stringify(store.threadState("t1")) === JSON.stringify({ summary: "", summarizedUntil: 0 }));
store.saveThreadState("t1", "## 已确认事实\n- A", ids[1]);
check("state round-trips", JSON.stringify(store.threadState("t1")) === JSON.stringify({ summary: "## 已确认事实\n- A", summarizedUntil: ids[1] }));
store.saveThreadState("t1", "## 已确认事实\n- A\n- B", ids[2]);
check("state overwrites (single row)", store.threadState("t1").summarizedUntil === ids[2]);

// 2) cold range: strictly (cursor, windowStart) — no double counting, no gaps
const cold = store.threadEventsBetween("t1", ids[1], ids[4]);
check("cold range excludes cursor event", cold[0].id === ids[2], JSON.stringify(cold.map((e) => e.id)));
check("cold range excludes window start", cold[cold.length - 1].id === ids[3], JSON.stringify(cold.map((e) => e.id)));
check("cold range is oldest-first", JSON.stringify(cold.map((e) => e.id)) === JSON.stringify([ids[2], ids[3]]));

// 3) empty ranges are empty, not "everything"
check("no cold when cursor is adjacent", store.threadEventsBetween("t1", ids[2], ids[3]).length === 0);
check("no cold when window starts at cursor", store.threadEventsBetween("t1", ids[3], ids[3]).length === 0);

// 4) window query excludes the current event
const window = store.threadEventsBefore("t1", ids[4], 10);
check("window excludes current", !window.some((e) => e.id === ids[4]), JSON.stringify(window.map((e) => e.id)));
check("window is oldest-first", JSON.stringify(window.map((e) => e.id)) === JSON.stringify(ids.slice(0, 4)));

// 5) lastEventId tracks the newest event
check("lastEventId", store.lastEventId("t1") === ids[4]);

store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
