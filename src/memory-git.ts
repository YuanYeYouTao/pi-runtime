import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { MemoryStore } from "./memory.ts";

export type GitExportResult = {
  dir: string;
  files: number;
  commit: string | null;
  changed: boolean;
  error?: string;
};

const git = (cwd: string, args: string[]): { ok: boolean; out: string } => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
};

/** A stable, filesystem-safe path for a subject/key pair. */
function fileFor(subject: string | null, key: string): string {
  const safeSubject = (subject ?? "global").replace(/[^\p{L}\p{N}._-]/gu, "_");
  const safeKey = key.replace(/[^\p{L}\p{N}._-]/gu, "_");
  return path.join("memories", safeSubject, `${safeKey}.md`);
}

function renderMemory(row: {
  id: number;
  subject: string | null;
  category: string;
  key: string;
  content: string;
  importance: number;
  status: string;
  evidence_event_id: number | null;
  evidence_quote: string | null;
  updated_at: string;
  reason: string | null;
}): string {
  return [
    "---",
    `id: ${row.id}`,
    `key: ${row.key}`,
    `subject: ${row.subject ?? "global"}`,
    `category: ${row.category}`,
    `importance: ${row.importance}`,
    `status: ${row.status}`,
    `updated_at: ${row.updated_at}`,
    `evidence_event_id: ${row.evidence_event_id ?? "null"}`,
    `reason: ${row.reason ?? "null"}`,
    "---",
    "",
    row.content,
    "",
    row.evidence_quote ? `> 依据（事件 #${row.evidence_event_id}）：${row.evidence_quote}` : "> 无证据引用（手工写入）",
    "",
  ].join("\n");
}

/**
 * Project the memory store into a Git repository.
 *
 * The database stays the authority — this is a *view* for humans: readable files, a diff per
 * change, and a checkout that can be pushed to another machine. It deliberately carries the
 * evidence quote into the file, because "why is this remembered" is the thing a reviewer
 * actually asks and the one thing a plain notes repo cannot answer.
 */
export function exportMemoryToGit(memory: MemoryStore, dataDir: string, options: { message?: string } = {}): GitExportResult {
  const dir = path.join(dataDir, "memory-repo");
  mkdirSync(dir, { recursive: true });

  // Check for `.git` *in this directory*. `git rev-parse` walks up the tree, so inside another
  // repository (a checkout, a test fixture) it would happily report "already a repo" and then
  // commit the projection into the caller's repository — which is exactly what happened once.
  if (!existsSync(path.join(dir, ".git"))) {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "pi-rt@localhost"]);
    git(dir, ["config", "user.name", "pi-rt"]);
  }

  const rows = memory.list(undefined, true);
  const active = rows.filter((row) => row.status === "active");

  // Rewrite the whole tree each time. Memory is small, and a full rewrite keeps the diff
  // honest: what changed is exactly what the DB says changed.
  const memoriesDir = path.join(dir, "memories");
  rmSync(memoriesDir, { recursive: true, force: true });
  mkdirSync(memoriesDir, { recursive: true });

  let files = 0;
  for (const row of rows) {
    const target = path.join(dir, fileFor(row.subject, row.key));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, renderMemory(row), "utf8");
    files++;
  }

  const bySubject = new Map<string, typeof active>();
  for (const row of active) {
    const bucket = bySubject.get(row.subject ?? "global") ?? [];
    bucket.push(row);
    bySubject.set(row.subject ?? "global", bucket);
  }
  const index: string[] = [
    "# MEMORY",
    "",
    "由 `pi-rt memory-git` 从数据库导出。**这里是投影，不是权威源**：请改数据库，不要改这个文件。",
    "",
    `活跃记忆：${active.length} 条（导出时间不写进文件，否则每次导出都会产生一个空提交）`,
    "",
  ];
  for (const [subject, bucket] of [...bySubject.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    index.push(`## ${subject}`);
    for (const row of bucket) {
      index.push(`- [${row.category}·${row.importance}] \`${row.key}\` — ${row.content.slice(0, 80)}`);
    }
    index.push("");
  }
  writeFileSync(path.join(dir, "MEMORY.md"), index.join("\n"), "utf8");
  files++;

  git(dir, ["add", "-A"]);
  const staged = git(dir, ["diff", "--cached", "--name-only"]);
  const changed = staged.ok && staged.out.length > 0;

  let commit: string | null = null;
  if (changed) {
    const message = options.message ?? `sync memory: ${active.length} active, ${rows.length} total`;
    const result = git(dir, ["commit", "-q", "-m", message]);
    if (!result.ok) return { dir, files, commit: null, changed: true, error: result.out };
    const hash = git(dir, ["rev-parse", "--short", "HEAD"]);
    commit = hash.ok ? hash.out : null;
  }

  return { dir, files, commit, changed };
}
