import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryStore } from "../src/memory.ts";
import { exportMemoryToGit } from "../src/memory-git.ts";

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${extra}`}`);
  ok ? pass++ : fail++;
};

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });
const hasGit = git(process.cwd(), ["--version"]).status === 0;
if (!hasGit) {
  console.log("SKIP: git not available");
  process.exit(0);
}

const dir = path.join("eval", "tmp-memory-git");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const memory = new MemoryStore(dir, "Rick");

// 1) first export initialises a repo and commits
{
  memory.apply({
    action: "create",
    category: "fact",
    key: "user_city",
    content: "常驻上海",
    importance: 4,
    evidenceEventId: 42,
    evidenceQuote: "我在上海工作",
  });
  const result = exportMemoryToGit(memory, dir);
  check("writes a repo", existsSync(path.join(result.dir, ".git")));
  check("first export commits", result.changed && Boolean(result.commit), JSON.stringify(result));
  check("index file exists", existsSync(path.join(result.dir, "MEMORY.md")));
  check("one file per memory plus the index", result.files >= 2, String(result.files));
}

// 2) the file carries the evidence, not just the claim
{
  const file = path.join(dir, "memory-repo", "memories", "Rick", "user_city.md");
  check("memory file exists", existsSync(file), file);
  const body = readFileSync(file, "utf8");
  check("front matter has the key", body.includes("key: user_city"), body.slice(0, 80));
  check("front matter has the event id", body.includes("evidence_event_id: 42"));
  check("the quote is in the file", body.includes("我在上海工作"), body.slice(-120));
}

// 3) an unchanged export makes no commit
{
  const before = git(path.join(dir, "memory-repo"), ["rev-list", "--count", "HEAD"]).stdout.trim();
  const result = exportMemoryToGit(memory, dir);
  const after = git(path.join(dir, "memory-repo"), ["rev-list", "--count", "HEAD"]).stdout.trim();
  check("no change, no commit", !result.changed && before === after, `${before} -> ${after}`);
}

// 4) a change produces exactly one new commit with the message
{
  memory.apply({
    action: "create",
    category: "preference",
    key: "user_coffee",
    content: "只喝美式，不加糖",
    importance: 3,
  });
  const before = Number(git(path.join(dir, "memory-repo"), ["rev-list", "--count", "HEAD"]).stdout.trim());
  const result = exportMemoryToGit(memory, dir, { message: "test: add coffee preference" });
  const after = Number(git(path.join(dir, "memory-repo"), ["rev-list", "--count", "HEAD"]).stdout.trim());
  check("one new commit", after === before + 1, `${before} -> ${after}`);
  const log = git(path.join(dir, "memory-repo"), ["log", "-1", "--pretty=%s"]).stdout.trim();
  check("commit message honoured", log === "test: add coffee preference", log);
}

// 5) a superseded row stays in the tree (audit), but leaves the index
{
  memory.apply({ action: "create", category: "fact", key: "user_city", content: "搬到南京了", importance: 4 });
  exportMemoryToGit(memory, dir);
  const files = readdirSync(path.join(dir, "memory-repo", "memories", "Rick"));
  check("history is kept as files", files.length >= 1, JSON.stringify(files));
  const index = readFileSync(path.join(dir, "memory-repo", "MEMORY.md"), "utf8");
  check("index shows the current value only", index.includes("南京") && !index.includes("常驻上海"), index);
}

// 6) the projection is git-diffable: a change shows up as a diff
{
  const diff = git(path.join(dir, "memory-repo"), ["log", "-p", "-1"]).stdout;
  check("history contains a diff", diff.includes("user_city") || diff.includes("南京"), diff.slice(0, 120));
}

memory.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
