import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { persistRecord, isNoise, truncatePayload, NOISE_TYPES, DEFAULT_MAX_PAYLOAD } from "../src/event-log.ts";
import { Store } from "../src/db.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

// 1) streaming and turn scaffolding is dropped entirely
for (const type of ["message_update", "message_start", "message_end", "turn_start", "turn_end", "agent_start", "tool_execution_update"]) {
  check(`drops ${type}`, persistRecord({ type, delta: "x" }) === null);
}
check("noise list is exported", NOISE_TYPES.includes("message_update") && isNoise("turn_start"));

// 2) tool results are kept, compacted to the meaningful fields
{
  const kept = persistRecord({
    type: "tool_execution_end",
    toolName: "bash",
    toolCallId: "call_1",
    isError: false,
    result: "ok",
    extra: "noise",
  });
  check("keeps tool_execution_end", kept?.type === "tool_execution_end");
  const payload = kept.payload;
  check("keeps the tool name", payload.toolName === "bash", JSON.stringify(payload));
  check("keeps the result", payload.output === "ok", JSON.stringify(payload));
  check("drops unrelated fields", payload.extra === undefined, JSON.stringify(payload));
}

// 3) a failed tool call is marked
{
  const kept = persistRecord({ type: "tool_execution_end", toolName: "bash", error: "exit 1" });
  check("flags tool errors", kept.payload.isError === true, JSON.stringify(kept.payload));
  check("keeps the error text", kept.payload.output === "exit 1", JSON.stringify(kept.payload));
}

// 4) agent completion keeps only the outcome
{
  const kept = persistRecord({ type: "agent_end", stopReason: "end_turn", messages: ["huge"], usage: { big: true } });
  check("compacts agent_end", Object.keys(kept.payload).sort().join(",") === "error,stopReason,type", JSON.stringify(kept.payload));
  check("keeps the stop reason", kept.payload.stopReason === "end_turn");
}

// 5) oversized payloads become a preview with an honest marker
{
  const huge = { type: "custom", blob: "x".repeat(5000) };
  const kept = persistRecord(huge, 200);
  check("marks truncation", kept.payload.truncated === true);
  check("records the original size", kept.payload.originalChars > 5000, String(kept.payload.originalChars));
  check("preview is bounded", kept.payload.preview.length <= 200, String(kept.payload.preview.length));
}

// 6) small payloads are stored unchanged
{
  const kept = persistRecord({ type: "usage", total: 12 });
  check("small payload untouched", kept.payload.truncated === undefined && kept.payload.total === 12, JSON.stringify(kept.payload));
}

// 7) junk input is not persisted
{
  check("ignores non-objects", persistRecord(null) === null && persistRecord("x") === null);
}

// 8) truncatePayload is safe on unserialisable input
{
  const circular = { type: "custom" };
  circular.self = circular;
  const result = truncatePayload(circular, 100);
  check("handles circular payloads", result.truncated === true || typeof result === "object");
}

// 9) store-level: delete noise, truncate the rest, report sizes
{
  const dir = path.join("eval", "tmp-eventlog");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const store = new Store(path.join(dir, "runtime.db"));

  store.appendEvent("t1", "message_update", { delta: "x".repeat(1000) });
  store.appendEvent("t1", "message_update", { delta: "y".repeat(1000) });
  store.appendEvent("t1", "agent_end", { blob: "z".repeat(3000) });
  store.appendEvent("t1", "usage", { total: 10 });

  const before = store.eventStats();
  check("counts rows and bytes", before.rows === 4 && before.bytes > 5000, JSON.stringify(before));

  check("dry run deletes nothing", store.deleteEventsOfTypes(["message_update"], true) === 2 && store.eventStats().rows === 4);
  check("deletes only the given types", store.deleteEventsOfTypes(["message_update"]) === 2 && store.eventStats().rows === 2);

  const shrunk = store.truncateEventPayloads(200);
  check("truncates oversized rows", shrunk.rows === 1 && shrunk.freedBytes > 2000, JSON.stringify(shrunk));
  check("kept rows survive", store.eventStats().rows === 2);

  const payload = JSON.parse(store.eventsOf("t1").find((row) => row.type === "agent_end").payload);
  check("truncated payload is self-describing", payload.truncated === true && payload.originalChars > 2000, JSON.stringify(payload).slice(0, 120));

  store.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
