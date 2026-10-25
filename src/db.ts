import { DatabaseSync } from "node:sqlite";

export type TaskStatus = "queued" | "running" | "done" | "failed";

export type ConversationEventRow = {
  id: number;
  thread: string;
  speaker: string;
  role: "user" | "assistant";
  text: string;
  task_id: string | null;
  distilled_at: string | null;
  created_at: string;
};

export type TaskRow = {
  id: string;
  prompt: string;
  cwd: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  result: string | null;
  error: string | null;
  thread: string;
  distilled_at: string | null;
};

const now = (): string => new Date().toISOString();
const shortId = (): string => `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/**
 * The single source of truth.
 *
 * Design rule borrowed from the systems we are studying: the orchestrator owns all
 * state; the executor (pi) is stateless and disposable. That is what makes crash
 * recovery possible — replay the task row, not the process memory.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id         TEXT PRIMARY KEY,
        prompt     TEXT NOT NULL,
        cwd        TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        result     TEXT,
        error      TEXT
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT NOT NULL,
        type       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);");

    // v2 columns: tasks now belong to a conversation thread and track distillation.
    this.ensureColumn("tasks", "thread", "TEXT NOT NULL DEFAULT 'default'");
    this.ensureColumn("tasks", "distilled_at", "TEXT");

    // Append-only conversation log. Every memory must point at one of these rows by id,
    // which is what makes "evidence" checkable instead of rhetorical.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        thread       TEXT NOT NULL,
        speaker      TEXT NOT NULL,
        role         TEXT NOT NULL,
        text         TEXT NOT NULL,
        task_id      TEXT,
        distilled_at TEXT,
        created_at   TEXT NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_ce_thread ON conversation_events(thread, id);");

    // Transport-level idempotency: IM platforms redeliver when an ack is slow, and a
    // redelivered message must not become a second event (and therefore a second memory).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_messages (
        channel     TEXT NOT NULL,
        external_id TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (channel, external_id)
      );
    `);
    this.backfillEvents();
  }

  /** Existing task history becomes conversation events, so old threads stay extractable. */
  private backfillEvents(): void {
    const existing = this.db.prepare("SELECT COUNT(*) c FROM conversation_events").get() as { c: number };
    if (Number(existing.c) > 0) return;
    const tasks = this.db.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all() as TaskRow[];
    if (tasks.length === 0) return;
    for (const task of tasks) {
      this.addConversationEvent(task.thread, "user_1", "user", task.prompt, task.id, task.distilled_at);
      if (task.result) {
        this.addConversationEvent(task.thread, "agent", "assistant", task.result, task.id, task.distilled_at);
      }
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
    if (!columns.includes(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  createTask(prompt: string, cwd: string, thread = "default"): string {
    const id = shortId();
    const ts = now();
    this.db
      .prepare("INSERT INTO tasks (id, prompt, cwd, status, created_at, updated_at, thread) VALUES (?, ?, ?, 'queued', ?, ?, ?)")
      .run(id, prompt, cwd, ts, ts, thread);
    return id;
  }

  getTask(id: string): TaskRow | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return (row as TaskRow | undefined) ?? null;
  }

  listTasks(limit = 20): TaskRow[] {
    return this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as TaskRow[];
  }

  /** Insert an already-finished turn (used by the evaluator to replay transcripts). */
  insertDoneTurn(prompt: string, cwd: string, thread: string, result: string): string {
    const id = shortId();
    const ts = now();
    this.db
      .prepare(
        "INSERT INTO tasks (id, prompt, cwd, status, created_at, updated_at, result, thread) VALUES (?, ?, ?, 'done', ?, ?, ?, ?)",
      )
      .run(id, prompt, cwd, ts, ts, result, thread);
    return id;
  }

  claimNext(exclude: Set<string> = new Set()): TaskRow | null {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 20")
      .all() as TaskRow[];
    const row = rows.find((r) => !exclude.has(r.id));
    if (!row) return null;
    const res = this.db
      .prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(now(), row.id);
    if (Number(res.changes) !== 1) return null;
    return { ...row, status: "running" };
  }

  finishTask(id: string, result: string): void {
    this.db
      .prepare("UPDATE tasks SET status = 'done', result = ?, error = NULL, updated_at = ? WHERE id = ?")
      .run(result, now(), id);
  }

  failTask(id: string, error: string): void {
    this.db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, now(), id);
  }

  /** Requeue tasks whose worker died mid-flight. */
  reapStale(maxAgeMinutes = 90): number {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
    const res = this.db
      .prepare("UPDATE tasks SET status = 'queued', updated_at = ? WHERE status = 'running' AND updated_at < ?")
      .run(now(), cutoff);
    return Number(res.changes);
  }

  appendEvent(taskId: string, type: string, payload: unknown): void {
    this.db
      .prepare("INSERT INTO events (task_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(taskId, type, JSON.stringify(payload), now());
  }

  eventsOf(taskId: string): Array<{ seq: number; type: string; payload: string; created_at: string }> {
    return this.db.prepare("SELECT seq, type, payload, created_at FROM events WHERE task_id = ? ORDER BY seq ASC").all(taskId) as any[];
  }

  /** Finished tasks that have not been fed to the memory extractor yet. */
  pendingTurns(thread?: string, limit = 12): TaskRow[] {
    const sql = thread
      ? "SELECT * FROM tasks WHERE status = 'done' AND distilled_at IS NULL AND thread = ? ORDER BY created_at ASC LIMIT ?"
      : "SELECT * FROM tasks WHERE status = 'done' AND distilled_at IS NULL ORDER BY created_at ASC LIMIT ?";
    return (thread ? this.db.prepare(sql).all(thread, limit) : this.db.prepare(sql).all(limit)) as TaskRow[];
  }

  pendingCount(thread?: string): number {
    const row = thread
      ? (this.db.prepare("SELECT COUNT(*) c FROM tasks WHERE status = 'done' AND distilled_at IS NULL AND thread = ?").get(thread) as { c: number })
      : (this.db.prepare("SELECT COUNT(*) c FROM tasks WHERE status = 'done' AND distilled_at IS NULL").get() as { c: number });
    return Number(row.c);
  }

  /** Threads with pending turns whose newest turn is older than `idleMinutes`. */
  idleThreads(idleMinutes: number): Array<{ thread: string; pending: number }> {
    const cutoff = new Date(Date.now() - idleMinutes * 60_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT thread, COUNT(*) pending, MAX(created_at) newest
           FROM tasks WHERE status = 'done' AND distilled_at IS NULL
          GROUP BY thread HAVING newest < ?`,
      )
      .all(cutoff) as Array<{ thread: string; pending: number }>;
    return rows;
  }

  markDistilled(ids: string[]): void {
    if (ids.length === 0) return;
    const statement = this.db.prepare("UPDATE tasks SET distilled_at = ? WHERE id = ?");
    const ts = now();
    for (const id of ids) statement.run(ts, id);
  }

  // ---- conversation events (the evidence layer) ----

  addConversationEvent(
    thread: string,
    speaker: string,
    role: "user" | "assistant",
    text: string,
    taskId: string | null = null,
    distilledAt: string | null = null,
  ): number {
    const result = this.db
      .prepare("INSERT INTO conversation_events (thread, speaker, role, text, task_id, distilled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(thread, speaker, role, text, taskId, distilledAt, now());
    return Number(result.lastInsertRowid);
  }

  /** True when this transport message is new; false when it was already processed. */
  claimMessage(channel: string, externalId: string): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO seen_messages (channel, external_id, created_at) VALUES (?, ?, ?)")
      .run(channel, externalId, now());
    return Number(result.changes) === 1;
  }

  conversationEvents(thread: string, limit = 200): ConversationEventRow[] {
    return this.db
      .prepare("SELECT * FROM conversation_events WHERE thread = ? ORDER BY id ASC LIMIT ?")
      .all(thread, limit) as ConversationEventRow[];
  }

  /** Highest event id in a thread — the current message when building its prompt. */
  lastEventId(thread: string): number {
    const row = this.db.prepare("SELECT MAX(id) id FROM conversation_events WHERE thread = ?").get(thread) as { id: number | null };
    return Number(row.id ?? 0);
  }

  /** Events strictly before `beforeId`, oldest first: the conversation window. */
  threadEventsBefore(thread: string, beforeId: number, limit = 60): ConversationEventRow[] {
    return this.db
      .prepare("SELECT * FROM conversation_events WHERE thread = ? AND id < ? ORDER BY id DESC LIMIT ?")
      .all(thread, beforeId, limit)
      .reverse() as ConversationEventRow[];
  }

  pendingEvents(thread?: string, limit = 40): ConversationEventRow[] {
    const sql = thread
      ? "SELECT * FROM conversation_events WHERE distilled_at IS NULL AND thread = ? ORDER BY id ASC LIMIT ?"
      : "SELECT * FROM conversation_events WHERE distilled_at IS NULL ORDER BY id ASC LIMIT ?";
    return (thread ? this.db.prepare(sql).all(thread, limit) : this.db.prepare(sql).all(limit)) as ConversationEventRow[];
  }

  /** Counts user turns, not events: one turn is a user message plus an assistant reply. */
  pendingTurnCount(thread?: string): number {
    const row = thread
      ? (this.db
          .prepare("SELECT COUNT(*) c FROM conversation_events WHERE distilled_at IS NULL AND role = 'user' AND thread = ?")
          .get(thread) as { c: number })
      : (this.db
          .prepare("SELECT COUNT(*) c FROM conversation_events WHERE distilled_at IS NULL AND role = 'user'")
          .get() as { c: number });
    return Number(row.c);
  }

  markEventsDistilled(ids: number[]): void {
    if (ids.length === 0) return;
    const statement = this.db.prepare("UPDATE conversation_events SET distilled_at = ? WHERE id = ?");
    const ts = now();
    for (const id of ids) statement.run(ts, id);
  }

  idleEventThreads(idleMinutes: number): Array<{ thread: string; pending: number }> {
    const cutoff = new Date(Date.now() - idleMinutes * 60_000).toISOString();
    return this.db
      .prepare(
        `SELECT thread, COUNT(*) pending, MAX(created_at) newest
           FROM conversation_events WHERE distilled_at IS NULL
          GROUP BY thread HAVING newest < ?`,
      )
      .all(cutoff) as Array<{ thread: string; pending: number }>;
  }

  close(): void {
    this.db.close();
  }
}
