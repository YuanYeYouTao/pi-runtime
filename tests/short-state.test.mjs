import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ShortStateStore, parseTtl, DEFAULT_TTL_MS, MAX_TTL_MS } from "../src/short-state.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const dir = path.join("eval", "tmp-short-state");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const store = new ShortStateStore(dir);

// 1) basic set/get with the default TTL
{
  const row = store.set("deploy_port", "8080");
  const ttlHours = (Date.parse(row.expires_at) - Date.now()) / 3_600_000;
  check("set returns the row", row.key === "deploy_port" && row.value === "8080");
  check("default ttl ≈ 24h", ttlHours > 23.5 && ttlHours <= 24.1, String(ttlHours));
  check("get returns the value", store.get("deploy_port")?.value === "8080");
}

// 2) same key overwrites instead of duplicating
{
  store.set("deploy_port", "9090", { ttlMs: 60 * 60 * 1_000 });
  check("overwrite updates value", store.get("deploy_port")?.value === "9090");
  check("overwrite keeps a single row", store.list().filter((r) => r.key === "deploy_port").length === 1);
}

// 3) expiry is evaluated on read (no background job)
{
  store.set("stale_link", "https://example.com", { ttlMs: 60 * 1_000 });
  const db = new DatabaseSync(path.join(dir, "runtime.db"));
  db.prepare("UPDATE short_state SET expires_at = ? WHERE key = ?").run(new Date(Date.now() - 1_000).toISOString(), "stale_link");
  db.close();
  check("expired row is not returned", store.get("stale_link") === undefined);
  check("expired row is not listed", store.list().every((r) => r.key !== "stale_link"));
}

// 4) prune only flips expired rows
{
  const before = store.list().length;
  const pruned = store.prune();
  check("prune marks the expired row", pruned === 1, String(pruned));
  check("prune keeps live rows", store.list().length === before);
}

// 5) scope isolation, with global visible from a thread
{
  store.set("task_progress", "第 2 步完成", { scope: "feishu:oc_1", ttlMs: 3 * 86_400_000 });
  store.set("global_note", "全局可见");
  check("thread scope sees its own key", store.get("task_progress", "feishu:oc_1")?.value === "第 2 步完成");
  check("other scope does not", store.get("task_progress", "feishu:oc_2") === undefined);
  check("thread scope still sees global", store.get("global_note", "feishu:oc_1")?.value === "全局可见");
}

// 6) key validation and value guard
{
  let threw = false;
  try {
    store.set("bad key!", "x");
  } catch {
    threw = true;
  }
  check("rejects invalid key", threw);
  check("rejects empty value", (() => {
    try {
      store.set("ok_key", "   ");
      return false;
    } catch {
      return true;
    }
  })());
}

// 7) ttl parsing
{
  check("parse 30m", parseTtl("30m") === 30 * 60_000);
  check("parse 12h", parseTtl("12h") === 12 * 3_600_000);
  check("parse 7d", parseTtl("7d") === 7 * 86_400_000);
  check("reject nonsense", (() => {
    try {
      parseTtl("soon");
      return false;
    } catch {
      return true;
    }
  })());
  check("reject too short", (() => {
    try {
      parseTtl("0m");
      return false;
    } catch {
      return true;
    }
  })());
  check("reject too long", (() => {
    try {
      parseTtl("40d");
      return false;
    } catch {
      return true;
    }
  })());
  check("default is 24h and cap is 30d", DEFAULT_TTL_MS === 86_400_000 && MAX_TTL_MS === 30 * 86_400_000);
}

// 8) newest first, and the block is budgeted
{
  store.set("a_old", "1");
  store.set("b_new", "2");
  const keys = store.list().map((r) => r.key);
  check("list is newest-first", keys.indexOf("b_new") < keys.indexOf("a_old"), JSON.stringify(keys));

  for (let i = 0; i < 20; i++) store.set(`bulk_${i}`, "x".repeat(40));
  const block = store.contextBlock(200);
  check("contextBlock respects the budget", block.text.length <= 400, String(block.text.length));
  check("contextBlock is never empty when rows exist", block.keys.length > 0);
  check("contextBlock mentions expiry", block.text.includes("过期"), block.text.slice(0, 60));
}

// 9) a second instance (another process) sees the same rows
{
  const other = new ShortStateStore(dir);
  check("cross-instance read", other.get("deploy_port")?.value === "9090");
  other.close();
}

// 10) delete
{
  check("remove works", store.remove("deploy_port") === true && store.get("deploy_port") === undefined);
  check("remove missing returns false", store.remove("never_existed") === false);
}

store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
