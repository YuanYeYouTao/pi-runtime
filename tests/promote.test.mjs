import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { ShortStateStore } from "../src/short-state.ts";
import { MemoryStore } from "../src/memory.ts";
import { promoteShortState } from "../src/promote.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const dir = path.join("eval", "tmp-promote");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const state = new ShortStateStore(dir);
const memory = new MemoryStore(dir, "Rick");

// 1) a normal slot promotes into memory and disappears from short state
{
  state.set("deploy_port", "8080", { ttlMs: 7 * 86_400_000 });
  state.markUsed(["deploy_port"]);
  const result = promoteShortState(state, memory, "deploy_port", { category: "fact" });
  check("promote succeeds", result.ok, JSON.stringify(result));
  check("memory key is traceable", result.memoryKey === "state_deploy_port", result.memoryKey);
  const row = memory.list().find((r) => r.key === "state_deploy_port");
  check("memory holds the value", row?.content === "8080", JSON.stringify(row?.content));
  check("short state row is gone", state.get("deploy_port") === undefined);
  check("provenance is recorded", String(row?.reason ?? "").includes("短状态晋升"), String(row?.reason));
}

// 2) promoting a missing or expired slot fails cleanly
{
  const result = promoteShortState(state, memory, "never_existed");
  check("missing slot rejected", !result.ok && result.reason.includes("不存在"), JSON.stringify(result));
}

// 3) credentials are refused at the slot level (a bare value has no keyword to match)
{
  let threw = false;
  try {
    state.set("db_password", "Passw0rd!2024", { ttlMs: 60_000 });
  } catch (error) {
    threw = String(error.message).includes("凭据");
  }
  check("credential slot is refused on write", threw);
}

// 3b) a credential-shaped destination key is refused even for a harmless slot
{
  state.set("port_note", "8080", { ttlMs: 60_000 });
  const result = promoteShortState(state, memory, "port_note", { memoryKey: "service_api_key" });
  check("sensitive destination rejected", !result.ok && result.reason.startsWith("sensitive"), JSON.stringify(result));
  check("slot is kept on rejection", state.get("port_note") !== undefined);
}

// 4) default key avoids clobbering an unrelated memory
{
  state.set("temp_switch", "on", { ttlMs: 60_000 });
  const result = promoteShortState(state, memory, "temp_switch");
  check("default prefix avoids collisions", result.memoryKey === "state_temp_switch", result.memoryKey);
}

// 5) a custom memory key and category are honoured
{
  state.set("review_time", "本周五上午十点", { ttlMs: 60_000 });
  const result = promoteShortState(state, memory, "review_time", { memoryKey: "group_review_time", category: "event", importance: 4 });
  const row = memory.list().find((r) => r.key === "group_review_time");
  check("custom key used", result.ok && row?.key === "group_review_time", JSON.stringify(row?.key));
  check("category honoured", row?.category === "event", String(row?.category));
  check("importance honoured", row?.importance === 4, String(row?.importance));
}

state.close();
memory.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
