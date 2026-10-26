import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractReminderDirectives, parseWhen, ReminderStore } from "../src/reminders.ts";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name} ${detail}`);
  }
}

// 1) directive extraction
{
  const raw = "好的，我记下了。\n<!--remind: 2026-10-27 15:00 | 跟王工对 Orion-7 进度-->";
  const { reminders, cleaned } = extractReminderDirectives(raw);
  check("one directive parsed", reminders.length === 1, JSON.stringify(reminders));
  check("time captured", reminders[0]?.when === "2026-10-27 15:00", reminders[0]?.when);
  check("text captured", reminders[0]?.text === "跟王工对 Orion-7 进度", reminders[0]?.text);
  check("token stripped from reply", !cleaned.includes("<!--"), cleaned);
  check("reply body kept", cleaned.includes("好的"), cleaned);
}

// 2) malformed directives stay in place
{
  const { reminders, cleaned } = extractReminderDirectives("<!--remind: 没有竖线-->");
  check("no false parse", reminders.length === 0);
  check("malformed left untouched", cleaned.includes("没有竖线"), cleaned);
}

// 3) multiple directives
{
  const raw = "<!--remind: 2026-11-01 09:00 | 交周报-->\n<!--remind: 2026-11-02 10:00 | 开评审会-->";
  const { reminders } = extractReminderDirectives(raw);
  check("two directives", reminders.length === 2, String(reminders.length));
}

// 4) absolute time is interpreted in +08:00
{
  const parsed = parseWhen("2026-10-27 15:00");
  check("absolute parsed", parsed instanceof Date && !Number.isNaN(parsed.getTime()));
  check("absolute is 07:00Z", parsed?.toISOString() === "2026-10-27T07:00:00.000Z", parsed?.toISOString());
}

// 5) relative time
{
  const now = new Date("2026-10-27T00:00:00.000Z");
  check("relative minutes", parseWhen("30分钟", now)?.toISOString() === "2026-10-27T00:30:00.000Z");
  check("relative hours", parseWhen("2小时", now)?.toISOString() === "2026-10-27T02:00:00.000Z");
  check("relative days", parseWhen("1天", now)?.toISOString() === "2026-10-28T00:00:00.000Z");
}

// 6) garbage time
check("garbage rejected", parseWhen("下周找个时间") === null);

// 7) store round-trip
const dir = mkdtempSync(path.join(tmpdir(), "pi-rem-"));
const store = new ReminderStore(dir);
const soon = new Date(Date.now() - 1000);
const later = new Date(Date.now() + 3_600_000);

const a = store.add({ thread: "qq:user:1", channel: "qq", chatId: "user:1", text: "到点了", dueAt: soon });
store.add({ thread: "qq:user:1", channel: "qq", chatId: "user:1", text: "一小时后", dueAt: later });

check("added row has id", a.id > 0, String(a.id));
check("one due now", store.due().length === 1, String(store.due().length));
check("pending has both", store.pending("qq:user:1").length === 2);

store.markFired(a.id);
check("fired leaves the due list", store.due().length === 0);
check("fired row kept for audit", store.byId(a.id)?.status === "fired", store.byId(a.id)?.status);

const b = store.pending("qq:user:1")[0];
check("cancel works", store.cancel(b.id) === true);
check("cancel is idempotent", store.cancel(b.id) === false);

// 8) duplicate detection
{
  const due = new Date("2026-12-01T07:00:00.000Z");
  store.add({ thread: "qq:user:2", channel: "qq", chatId: "user:2", text: "开会", dueAt: due });
  check("duplicate found", store.findDuplicate("qq:user:2", "开会", due) !== null);
  check("different text is not duplicate", store.findDuplicate("qq:user:2", "别的", due) === null);
}

try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows keeps the WAL handle open */ }

console.log(`\n${pass} passed, ${fail} failed`);
