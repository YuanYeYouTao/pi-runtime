import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/db.ts";
import { MemoryStore } from "../src/memory.ts";
import { archiveConversationEvents, backupDatabase, inspectArchives } from "../src/archive.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const dir = path.join("eval", "tmp-archive");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const store = new Store(path.join(dir, "runtime.db"));
const memory = new MemoryStore(dir, "Rick");

const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
const recent = new Date().toISOString();

const backdate = (id, iso) => {
  const db = new DatabaseSync(path.join(dir, "runtime.db"));
  db.prepare("UPDATE conversation_events SET created_at = ? WHERE id = ?").run(iso, id);
  db.close();
};

// three events: old+distilled, old+undistilled, recent+distilled
const oldDistilled = store.addConversationEvent("t_arch", "user_1", "user", "旧消息，已被提炼", null);
const oldPending = store.addConversationEvent("t_arch", "user_1", "user", "旧消息，还没提炼", null);
const newDistilled = store.addConversationEvent("t_arch", "user_1", "user", "新消息", null);
backdate(oldDistilled, old);
backdate(oldPending, old);
store.markEventsDistilled([oldDistilled, newDistilled]);

// 1) evidence protection: a live memory citing the old event keeps it out of the archive
{
  memory.apply({
    action: "create",
    category: "fact",
    key: "arch_probe",
    content: "旧消息，已被提炼",
    importance: 3,
    evidenceEventId: oldDistilled,
    evidenceQuote: "旧消息",
  });
  const result = archiveConversationEvents(store, dir, { olderThanDays: 30 });
  check("evidence-referenced event is kept", result.events === 0, JSON.stringify(result));
  check("skipped evidence is reported", result.skippedEvidence >= 1, String(result.skippedEvidence));
  check("undistilled event is reported", result.skippedUndistilled === 1, String(result.skippedUndistilled));
  check("nothing written when nothing qualifies", result.file === null);
}

// 2) once the evidence link goes away, the old distilled event is archived
{
  const row = memory.list().find((item) => item.key === "arch_probe");
  if (row) memory.forget(row.id);

  const result = archiveConversationEvents(store, dir, { olderThanDays: 30 });
  check("archives exactly one event", result.events === 1, JSON.stringify(result));
  check("writes a file", Boolean(result.file) && existsSync(result.file));
  check("reports compressed size", result.bytes > 0, String(result.bytes));

  const jsonl = gunzipSync(readFileSync(result.file)).toString("utf8").trim();
  const rows = jsonl.split("\n").map((line) => JSON.parse(line));
  check("archive holds the original row", rows.length === 1 && rows[0].id === oldDistilled, JSON.stringify(rows[0]).slice(0, 80));
  check("archive keeps the text", rows[0].text === "旧消息，已被提炼", JSON.stringify(rows[0].text));

  const remaining = store.conversationEvents("t_arch", 100).map((row) => row.id);
  check("archived event left the table", !remaining.includes(oldDistilled), JSON.stringify(remaining));
  check("undistilled event stays", remaining.includes(oldPending));
  check("recent event stays", remaining.includes(newDistilled));
}

// 3) dry run reports without touching anything
{
  const before = store.conversationEvents("t_arch", 100).length;
  const result = archiveConversationEvents(store, dir, { olderThanDays: 30, includeUndistilled: true, dryRun: true });
  check("dry run counts the candidate", result.events === 1, JSON.stringify(result));
  check("dry run writes nothing", result.file === null);
  check("dry run deletes nothing", store.conversationEvents("t_arch", 100).length === before);
}

// 4) backups are consistent, compressed, and pruned by retention
{
  const first = backupDatabase(store, dir, 2, new Date("2026-01-01T00:00:00Z"));
  check("backup file exists", existsSync(first.file));
  const raw = gunzipSync(readFileSync(first.file));
  check("backup is a sqlite database", raw.subarray(0, 15).toString() === "SQLite format 3", raw.subarray(0, 15).toString());

  backupDatabase(store, dir, 2, new Date("2026-01-02T00:00:00Z"));
  const third = backupDatabase(store, dir, 2, new Date("2026-01-03T00:00:00Z"));
  check("retention prunes the oldest", third.pruned.length === 1, JSON.stringify(third.pruned));
  check("keeps the requested number", readdirSync(path.join(dir, "backups")).length === 2, String(readdirSync(path.join(dir, "backups")).length));
}

// 5) the snapshot is restorable: it contains our tables
{
  const files = readdirSync(path.join(dir, "backups")).sort();
  const restored = path.join(dir, "restored.db");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(restored, gunzipSync(readFileSync(path.join(dir, "backups", files[files.length - 1]))));
  const db = new DatabaseSync(restored);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  check("restored db has conversation_events", tables.includes("conversation_events"));
  check("restored db has memories", tables.includes("memories"));
  const count = db.prepare("SELECT COUNT(*) n FROM conversation_events").get();
  check("restored db has data", count.n >= 2, String(count.n));
  db.close();
}

// 6) archive/backup inventory
{
  const summary = inspectArchives(dir);
  check("inventory counts archives", summary.archive.files === 1 && summary.archive.bytes > 0, JSON.stringify(summary.archive));
  check("inventory counts backups", summary.backups.files === 2, JSON.stringify(summary.backups));
}

store.close();
memory.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
