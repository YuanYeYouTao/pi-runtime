import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { detectSecret, isSensitiveName } from "./secrets.ts";

export type ShortStateRow = {
  key: string;
  scope: string;
  value: string;
  expires_at: string;
  status: "active" | "stale";
  source_event_id: number | null;
  use_count: number;
  created_at: string;
  updated_at: string;
};

export type SetOptions = {
  scope?: string;
  ttlMs?: number;
  sourceEventId?: number | null;
};

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_TTL_MS = 60 * 1_000;
const GLOBAL_SCOPE = "global";
const KEY_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;

const now = (): string => new Date().toISOString();

/** `30m` / `12h` / `7d` → milliseconds. Rejects anything ambiguous instead of guessing. */
export function parseTtl(input: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)$/i.exec(input.trim());
  if (!match) throw new Error(`ttl 格式不对：${input}（用 30m / 12h / 7d 这种写法）`);
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const ms = amount * multiplier;
  if (ms < MIN_TTL_MS) throw new Error(`ttl 太短：${input}（最少 1 分钟）`);
  if (ms > MAX_TTL_MS) throw new Error(`ttl 太长：${input}（最多 30 天）`);
  return ms;
}

/**
 * Short-lived, key-addressed state: ports, pending links, task progress.
 *
 * This is deliberately not `MemoryStore`:
 * - no subject, no evidence event, no four-way verdict — it is a slot, not a belief;
 * - it expires, and expiry is evaluated on read (SQLite has no native TTL);
 * - it is written synchronously, because "I remembered it" must be true at the moment it is
 *   said, unlike long-term memory which is extracted in a later batch.
 */
export class ShortStateStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, "runtime.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS short_state (
        key             TEXT NOT NULL,
        scope           TEXT NOT NULL,
        value           TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active',
        source_event_id INTEGER,
        use_count       INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
    `);
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_short_active ON short_state(scope, key) WHERE status = 'active';");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_short_read ON short_state(scope, status, expires_at);");
  }

  /** Upsert one slot. Same (scope, key) replaces the value and restarts the clock. */
  set(key: string, value: string, options: SetOptions = {}): ShortStateRow {
    const normalized = key.trim();
    if (!KEY_PATTERN.test(normalized)) {
      throw new Error(`key 不合法：${key}（小写字母/数字/._:-，最长 64）`);
    }
    if (!value.trim()) throw new Error("value 不能为空");

    // Short state is injected into prompts, so it is held to the same standard as memory:
    // a credential must not live here either. The name check catches bare values that no
    // pattern could recognise (e.g. `db_password = Passw0rd!2024`).
    if (isSensitiveName(normalized) || detectSecret(value).sensitive) {
      throw new Error(`拒绝写入：${normalized} 看起来是凭据，短状态同样不保存密钥`);
    }

    const scope = (options.scope ?? GLOBAL_SCOPE).trim() || GLOBAL_SCOPE;
    const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, options.ttlMs ?? DEFAULT_TTL_MS));
    const ts = now();
    const expiresAt = new Date(Date.now() + ttl).toISOString();

    // BEGIN IMMEDIATE: several processes share this file, and a read-then-upgrade transaction
    // is what produces SQLITE_BUSY under WAL.
    //
    // No ON CONFLICT here: the unique index is *partial* (`WHERE status='active'`), and SQLite's
    // upsert clause cannot target a partial index. An explicit update-or-insert inside the
    // transaction is equivalent and does not depend on that detail.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT key FROM short_state WHERE scope = ? AND key = ? AND status = 'active'")
        .get(scope, normalized);

      if (existing) {
        this.db
          .prepare(
            "UPDATE short_state SET value = ?, expires_at = ?, source_event_id = ?, updated_at = ? WHERE scope = ? AND key = ? AND status = 'active'",
          )
          .run(value.trim(), expiresAt, options.sourceEventId ?? null, ts, scope, normalized);
      } else {
        this.db
          .prepare(
            `INSERT INTO short_state (key, scope, value, expires_at, status, source_event_id, use_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?)`,
          )
          .run(normalized, scope, value.trim(), expiresAt, options.sourceEventId ?? null, ts, ts);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(normalized, scope)!;
  }

  /** Active and not expired. Expiry is evaluated here, not by a background job. */
  get(key: string, scope = GLOBAL_SCOPE): ShortStateRow | undefined {
    const ts = now();
    return this.db
      .prepare(
        `SELECT * FROM short_state
          WHERE key = ? AND scope IN (?, 'global') AND status = 'active' AND expires_at > ?
          ORDER BY scope = ? DESC, updated_at DESC, rowid DESC LIMIT 1`,
      )
      .get(key, scope, ts, scope) as ShortStateRow | undefined;
  }

  list(scope = GLOBAL_SCOPE, limit = 50): ShortStateRow[] {
    const ts = now();
    return this.db
      .prepare(
        `SELECT * FROM short_state
          WHERE scope IN (?, 'global') AND status = 'active' AND expires_at > ?
          ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
      )
      .all(scope, ts, limit) as ShortStateRow[];
  }

  /** Mark expired rows stale instead of deleting: "it just expired" is still answerable. */
  prune(): number {
    const ts = now();
    const result = this.db
      .prepare("UPDATE short_state SET status = 'stale', updated_at = ? WHERE status = 'active' AND expires_at <= ?")
      .run(ts, ts);
    return Number(result.changes);
  }

  remove(key: string, scope = GLOBAL_SCOPE): boolean {
    const result = this.db.prepare("DELETE FROM short_state WHERE key = ? AND scope = ?").run(key, scope);
    return Number(result.changes) > 0;
  }

  markUsed(keys: string[], scope = GLOBAL_SCOPE): void {
    if (keys.length === 0) return;
    const ts = now();
    const statement = this.db.prepare(
      "UPDATE short_state SET use_count = use_count + 1, updated_at = updated_at WHERE key = ? AND status = 'active' AND scope IN (?, 'global')",
    );
    for (const key of keys) statement.run(key, scope);
  }

  /**
   * Render for injection. Sorted newest-first, capped by characters, and each line carries a
   * remaining-time hint so the model can tell a fresh slot from a stale one.
   */
  contextBlock(budgetChars = 300, scope = GLOBAL_SCOPE): { text: string; keys: string[] } {
    const rows = this.list(scope, 50);
    const lines: string[] = [];
    const keys: string[] = [];
    let used = 0;
    for (const row of rows) {
      const hoursLeft = Math.max(0, Math.round((Date.parse(row.expires_at) - Date.now()) / 3_600_000));
      const line = `- ${row.key} = ${row.value}（临时状态，约 ${hoursLeft} 小时后过期）`;
      if (used + line.length > budgetChars && lines.length > 0) break;
      lines.push(line);
      keys.push(row.key);
      used += line.length;
    }
    if (lines.length === 0) return { text: "", keys: [] };
    return {
      text: ["## 短期状态（本次会话有效，过期作废）", ...lines].join("\n"),
      keys,
    };
  }

  close(): void {
    this.db.close();
  }
}
