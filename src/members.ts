import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export type Member = {
  id: number;
  channel: string;
  external_id: string;
  display_name: string;
  is_owner: number;
  created_at: string;
  updated_at: string;
};

const now = (): string => new Date().toISOString();

/**
 * Identity layer: channel user ids → stable people.
 *
 * Memory attribution breaks the moment two channels or two nicknames mean the same person,
 * so every event carries a resolved display name and the owner is explicit. Without this,
 * "current_speaker" is a pronoun and layer two cannot work.
 */
export class Members {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, "runtime.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS members (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        channel      TEXT NOT NULL,
        external_id  TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_owner     INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE(channel, external_id)
      );
    `);
  }

  upsert(channel: string, externalId: string, displayName: string, isOwner = false): Member {
    const existing = this.resolve(channel, externalId);
    const ts = now();
    if (existing) {
      if (existing.display_name !== displayName || (isOwner && !existing.is_owner)) {
        this.db
          .prepare("UPDATE members SET display_name = ?, is_owner = MAX(is_owner, ?), updated_at = ? WHERE id = ?")
          .run(displayName, isOwner ? 1 : 0, ts, existing.id);
      }
      return this.resolve(channel, externalId)!;
    }
    this.db
      .prepare("INSERT INTO members (channel, external_id, display_name, is_owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(channel, externalId, displayName, isOwner ? 1 : 0, ts, ts);
    return this.resolve(channel, externalId)!;
  }

  resolve(channel: string, externalId: string): Member | undefined {
    return this.db
      .prepare("SELECT * FROM members WHERE channel = ? AND external_id = ?")
      .get(channel, externalId) as Member | undefined;
  }

  list(channel?: string): Member[] {
    return (channel
      ? this.db.prepare("SELECT * FROM members WHERE channel = ? ORDER BY is_owner DESC, display_name").all(channel)
      : this.db.prepare("SELECT * FROM members ORDER BY is_owner DESC, display_name").all()) as Member[];
  }

  owner(): Member | undefined {
    return this.db.prepare("SELECT * FROM members WHERE is_owner = 1 LIMIT 1").get() as Member | undefined;
  }

  /**
   * Ensure the canonical owner identity exists.
   *
   * `is_owner` means "this identity belongs to the owner", not "this is the only owner row":
   * Rick may have a local identity plus a Feishu one and a Telegram one, all flagged.
   */
  ensureOwner(name: string): Member {
    const byName = this.db.prepare("SELECT * FROM members WHERE display_name = ? AND is_owner = 1 LIMIT 1").get(name) as Member | undefined;
    if (byName) return byName;

    const sameName = this.db.prepare("SELECT * FROM members WHERE display_name = ? LIMIT 1").get(name) as Member | undefined;
    if (sameName) {
      this.db.prepare("UPDATE members SET is_owner = 1, updated_at = ? WHERE id = ?").run(now(), sameName.id);
      return this.resolve(sameName.channel, sameName.external_id)!;
    }
    return this.upsert("local", "owner", name, true);
  }

  /** Display names present in this conversation, owner first. */
  roster(): string[] {
    return this.list().map((member) => member.display_name);
  }

  close(): void {
    this.db.close();
  }
}
