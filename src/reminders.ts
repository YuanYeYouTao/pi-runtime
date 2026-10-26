import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/**
 * Reminders: a future moment tied to a thread, delivered back into the same chat.
 *
 * This is the one place where the runtime must act *without* being spoken to, which is why it
 * cannot live in memory (memory is belief about the user) or in short state (state feeds the
 * prompt, it does not push). Same delivery mechanism as a reply, different trigger.
 *
 * The write happens through a control token, for the same reason as short state: a real tool
 * call would need an extension round-trip through pi's RPC, while a token can be emitted with
 * the tools the model already has and is parsed deterministically on our side.
 *
 * Syntax: `<!--remind: 2026-10-27 15:00 | 跟王工对 Orion-7 进度-->`
 */
export type ReminderDirective = { when: string; text: string };

const DIRECTIVE = /<!--\s*remind:\s*([^|>]{4,40}?)\s*\|\s*([^>]{1,300}?)\s*-->/gi;

export function extractReminderDirectives(text: string): { reminders: ReminderDirective[]; cleaned: string } {
  const reminders: ReminderDirective[] = [];
  const cleaned = (text ?? "").replace(DIRECTIVE, (_match, when: string, body: string) => {
    const at = when.trim();
    const what = body.trim();
    if (!at || !what) return _match;
    reminders.push({ when: at, text: what });
    return "";
  });

  return { reminders, cleaned: cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() };
}

/**
 * Parse a wall-clock time the model wrote in the user's timezone.
 *
 * The container runs in UTC while the user does not, so the offset has to be explicit. A fixed
 * +08:00 keeps this dependency-free; the day where a user lives somewhere else is the day this
 * becomes a real timezone library call.
 */
export function parseWhen(when: string, now = new Date(), offsetMinutes = 480): Date | null {
  const match = when.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (match) {
    const [, y, mo, d, hh = "9", mm = "0"] = match;
    const stamp = Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(hh) - offsetMinutes / 60,
      Number(mm),
    );
    const parsed = new Date(stamp);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // Relative forms the model reaches for when the user says "20 分钟后".
  const relative = when.match(/^\+?(\d+)\s*(分钟|小时|天|min|hour|h|d)$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = unit.startsWith("分") || unit === "min" ? amount * 60_000
      : unit.startsWith("小时") || unit === "hour" || unit === "h" ? amount * 3_600_000
        : amount * 86_400_000;
    return new Date(now.getTime() + ms);
  }

  const parsed = new Date(when);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type ReminderRow = {
  id: number;
  thread: string;
  channel: string;
  chatId: string;
  text: string;
  dueAt: string;
  status: string;
  createdAt: string;
  firedAt: string | null;
};

export class ReminderStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, "runtime.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        thread     TEXT NOT NULL,
        channel    TEXT NOT NULL,
        chat_id    TEXT NOT NULL,
        text       TEXT NOT NULL,
        due_at     TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        fired_at   TEXT
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_reminders_thread ON reminders(thread, status);");
  }

  add(input: { thread: string; channel: string; chatId: string; text: string; dueAt: Date }): ReminderRow {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO reminders (thread, channel, chat_id, text, due_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(input.thread, input.channel, input.chatId, input.text.trim(), input.dueAt.toISOString(), now);
    return this.byId(Number(result.lastInsertRowid))!;
  }

  byId(id: number): ReminderRow | null {
    const row = this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  /** Pending reminders that are due at or before `now`, oldest first. */
  due(now = new Date()): ReminderRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reminders
          WHERE status = 'pending' AND due_at <= ?
          ORDER BY due_at ASC
          LIMIT 20`,
      )
      .all(now.toISOString()) as Record<string, unknown>[];
    return rows.map(toRow);
  }

  pending(thread?: string): ReminderRow[] {
    const rows = (thread
      ? this.db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND thread = ? ORDER BY due_at ASC").all(thread)
      : this.db.prepare("SELECT * FROM reminders WHERE status = 'pending' ORDER BY due_at ASC").all()) as Record<string, unknown>[];
    return rows.map(toRow);
  }

  markFired(id: number): void {
    this.db
      .prepare("UPDATE reminders SET status = 'fired', fired_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  cancel(id: number): boolean {
    const result = this.db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id);
    return Number(result.changes) > 0;
  }

  /** A reminder the model re-stated for the same thread and minute is the same reminder. */
  findDuplicate(thread: string, text: string, dueAt: Date): ReminderRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM reminders
          WHERE thread = ? AND status = 'pending' AND text = ? AND due_at = ?`,
      )
      .get(thread, text.trim(), dueAt.toISOString()) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }
}

function toRow(row: Record<string, unknown>): ReminderRow {
  return {
    id: Number(row.id),
    thread: String(row.thread),
    channel: String(row.channel),
    chatId: String(row.chat_id),
    text: String(row.text),
    dueAt: String(row.due_at),
    status: String(row.status),
    createdAt: String(row.created_at),
    firedAt: row.fired_at ? String(row.fired_at) : null,
  };
}
