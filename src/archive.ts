import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Store } from "./db.ts";

export type ArchiveOptions = {
  /** Archive conversation events older than this many days. */
  olderThanDays?: number;
  /** Also archive events that were never distilled? Off by default: they are still pending work. */
  includeUndistilled?: boolean;
  dryRun?: boolean;
  now?: Date;
};

export type ArchiveResult = {
  events: number;
  bytes: number;
  file: string | null;
  skippedEvidence: number;
  skippedUndistilled: number;
};

/**
 * Move old conversation events out of the live table into a compressed JSONL file.
 *
 * Three exclusions, each for a concrete reason:
 * - **not distilled yet** — still pending work, archiving it would lose the memory;
 * - **referenced by an active memory's evidence** — deleting it would leave `evidence_event_id`
 *   dangling, and the evidence chain is the whole point of the event layer;
 * - **inside the summary window** — the rolling summary has not absorbed them yet.
 *
 * The archive keeps the original rows verbatim, so "we deleted it" is reversible.
 */
export function archiveConversationEvents(store: Store, dataDir: string, options: ArchiveOptions = {}): ArchiveResult {
  const olderThanDays = options.olderThanDays ?? 30;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000).toISOString();

  const selection = store.selectArchivableEvents(cutoff, options.includeUndistilled ?? false);
  const result: ArchiveResult = {
    events: 0,
    bytes: 0,
    file: null,
    skippedEvidence: selection.skippedEvidence,
    skippedUndistilled: selection.skippedUndistilled,
  };

  if (selection.rows.length === 0 || options.dryRun) {
    result.events = selection.rows.length;
    return result;
  }

  const archiveDir = path.join(dataDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const file = path.join(archiveDir, `conversation-events-${stamp}.jsonl.gz`);

  const jsonl = selection.rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const compressed = gzipSync(Buffer.from(jsonl, "utf8"), { level: 9 });
  writeFileSync(file, compressed);

  store.deleteConversationEvents(selection.rows.map((row) => row.id));

  result.events = selection.rows.length;
  result.bytes = compressed.length;
  result.file = file;
  return result;
}

export type BackupResult = { file: string; bytes: number; pruned: string[] };

/**
 * Snapshot the database, compressed, with retention.
 *
 * `VACUUM INTO` is used instead of copying the file: the database runs in WAL mode, and a naive
 * copy can capture a torn state. `VACUUM INTO` produces a consistent snapshot while the server
 * keeps writing.
 */
export function backupDatabase(store: Store, dataDir: string, keep = 7, now = new Date()): BackupResult {
  const backupDir = path.join(dataDir, "backups");
  mkdirSync(backupDir, { recursive: true });

  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const snapshot = path.join(backupDir, `runtime-${stamp}.db.snapshot`);
  const target = path.join(backupDir, `runtime-${stamp}.db.gz`);

  store.vacuumInto(snapshot);
  const raw = readFileSync(snapshot);
  const compressed = gzipSync(raw, { level: 9 });
  writeFileSync(target, compressed);
  rmSync(snapshot, { force: true });

  // Retention: newest first, drop the rest.
  const existing = readdirSync(backupDir)
    .filter((name) => name.startsWith("runtime-") && name.endsWith(".db.gz"))
    .sort()
    .reverse();
  const pruned = existing.slice(keep).map((name) => {
    rmSync(path.join(backupDir, name), { force: true });
    return name;
  });

  return { file: target, bytes: statSync(target).size, pruned };
}

export type ArchiveSummary = { files: number; bytes: number };

/** Hours since the newest backup, or null when there is none. */
export function newestBackupAgeHours(dataDir: string, now = new Date()): number | null {
  const dir = path.join(dataDir, "backups");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => name.endsWith(".db.gz"));
  if (files.length === 0) return null;
  const newest = files
    .map((name) => statSync(path.join(dir, name)).mtimeMs)
    .reduce((max, value) => Math.max(max, value), 0);
  return (now.getTime() - newest) / 3_600_000;
}

/** What is on disk, for `pi-rt archive --list` and the doctor output. */
export function inspectArchives(dataDir: string): { archive: ArchiveSummary; backups: ArchiveSummary } {
  const summarize = (dir: string): ArchiveSummary => {
    if (!existsSync(dir)) return { files: 0, bytes: 0 };
    const files = readdirSync(dir);
    return {
      files: files.length,
      bytes: files.reduce((sum, name) => sum + statSync(path.join(dir, name)).size, 0),
    };
  };
  return {
    archive: summarize(path.join(dataDir, "archive")),
    backups: summarize(path.join(dataDir, "backups")),
  };
}
